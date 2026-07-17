const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'player_db.json');

function loadPlayerDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("DB読み込みエラー:", e);
  }
  return {};
}

function savePlayerDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error("DB保存エラー:", e);
  }
}

let gameState = {
  players: [],       
  deck: [],          
  discardPile: [],   
  lastDiscardSet: [], 
  pendingDiscard: [], 
  currentTurn: 0,    
  buttonIndex: 0,    
  status: 'lobby',   
  turnState: 'discard', 
  rules: { x: 7, isAny: false, y: 1, z: 2, isChaos: false },
  roundHistory: [],
  reshuffleCount: 0,
  currentRoundNum: 1,
  roundResultData: null
};

function createDeck() {
  const suits = ['S', 'H', 'D', 'C'];
  let deck = [];
  for (let suit of suits) {
    for (let value = 1; value <= 13; value++) {
      deck.push({ suit, value, id: `${suit}-${value}` });
    }
  }
  deck.push({ suit: 'J', value: 0, id: 'Joker-1' });
  deck.push({ suit: 'J', value: 0, id: 'Joker-2' });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calculateHandScore(hand, isDeclarer) {
  let score = 0;
  for (let card of hand) {
    if (card.value === 0) {
      score += isDeclarer ? 0 : 14; 
    } else if (card.value >= 10) {
      score += 10;
    } else {
      score += card.value;
    }
  }
  return score;
}

function getCardString(card) {
  if (card.value === 0) return '🃏Joker';
  const suits = { 'S': '♠', 'H': '♥', 'D': '♦', 'C': '♣' };
  const valStr = card.value === 1 ? 'A' : card.value === 11 ? 'J' : card.value === 12 ? 'Q' : card.value === 13 ? 'K' : card.value;
  return `${suits[card.suit]}${valStr}`;
}

function startNewRound() {
  gameState.deck = createDeck();
  gameState.discardPile = [];
  gameState.lastDiscardSet = [];
  gameState.pendingDiscard = [];
  gameState.reshuffleCount = 0;
  for (let p of gameState.players) { p.hand = []; }
  gameState.status = 'setting_rules';
  gameState.currentTurn = gameState.buttonIndex;
  io.emit('stateUpdate', gameState);
}

function processDrawEnd() {
  gameState.discardPile.push(...gameState.pendingDiscard);
  gameState.lastDiscardSet = [...gameState.pendingDiscard];
  gameState.pendingDiscard = [];

  if (gameState.deck.length === 0) {
    gameState.reshuffleCount += 1;
    const keepIds = new Set(gameState.lastDiscardSet.map(c => c.id));
    let newDeck = [];
    let newDiscard = [];
    for (let c of gameState.discardPile) {
      if (keepIds.has(c.id)) newDiscard.push(c); else newDeck.push(c);
    }
    for (let i = newDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newDeck[i], newDeck[j]] = [newDeck[j], newDeck[i]];
    }

    let distributeCount = 0;
    if (gameState.reshuffleCount === 1) distributeCount = 3;
    else if (gameState.reshuffleCount === 2) distributeCount = 2;
    else if (gameState.reshuffleCount === 3) distributeCount = 1;

    let logMsg = `【山札枯渇】${gameState.reshuffleCount}回目のシャッフルを行いました。`;
    if (distributeCount > 0) {
      logMsg += `全員に手札を ${distributeCount} 枚ずつ追加配布します。`;
      for (let i = 0; i < distributeCount; i++) {
        for (let player of gameState.players) {
          if (newDeck.length > 0) player.hand.push(newDeck.pop());
        }
      }
    } else {
      logMsg += `追加配布なし。`;
    }

    gameState.roundHistory.push(`⚠️ ${logMsg}`);
    gameState.deck = newDeck;
    gameState.discardPile = newDiscard;
  }

  gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
  gameState.turnState = 'discard';
  io.emit('stateUpdate', gameState);
}

function executeYaniv(socketId) {
  const declarer = gameState.players.find(p => p.id === socketId);
  if (!declarer) return;

  const declarerScore = calculateHandScore(declarer.hand, true);
  
  for (let p of gameState.players) {
    p.score = 0;
  }

  let playerScoresData = gameState.players.map(p => {
    const isDecl = p.id === declarer.id;
    return {
      id: p.id,
      name: p.name,
      handDetails: p.hand.map(c => getCardString(c)).join(', '),
      rawScore: calculateHandScore(p.hand, isDecl),
      isAI: false,
      isDeclarer: isDecl,
      finalEarned: 0
    };
  });

  const minScore = Math.min(...playerScoresData.map(s => s.rawScore));
  const maxScore = Math.max(...playerScoresData.map(s => s.rawScore));
  const rivalsWithLowerScore = playerScoresData.filter(s => !s.isDeclarer && s.rawScore <= declarerScore);
  const isYanivReturned = rivalsWithLowerScore.length > 0;

  let getterName = "";
  let reward = 0;
  let summaryTitle = "";
  let summaryDesc = "";

  io.emit('yanivAlert', { announcer: declarer.name, isReturned: isYanivReturned });

  if (!isYanivReturned) {
    reward = (maxScore - minScore) * gameState.rules.y;
    declarer.score = reward;
    getterName = declarer.name;
    playerScoresData.find(s => s.id === declarer.id).finalEarned = reward;
    summaryTitle = `🎉 ${declarer.name} のヤニブ成功！`;
    summaryDesc = `手札点数 ${declarerScore}点 で安全に逃げ切りました。ゲッター報酬として [${reward} pt] を獲得します。`;
  } else {
    const bestRival = rivalsWithLowerScore.reduce((prev, curr) => prev.rawScore < curr.rawScore ? prev : curr);
    const targetNode = gameState.players.find(p => p.id === bestRival.id);
    reward = (maxScore - minScore) * gameState.rules.y * gameState.rules.z;
    targetNode.score = reward;
    getterName = bestRival.name;

    playerScoresData.find(s => s.id === bestRival.id).finalEarned = reward;
    summaryTitle = `⚡ ヤニブ返し発生！阻止成功！`;
    summaryDesc = `${declarer.name} の宣言ラインを、さらに低い手札（${bestRival.rawScore}点）の ${bestRival.name} が迎撃！ペナルティ倍率が適用され、${bestRival.name} が [${reward} pt] を強奪しました。`;
  }

  if (gameState.rules && gameState.rules.isChaos) {
    summaryDesc += ` (※カオスモードの確定倍率: 通常${gameState.rules.y}倍 / 返し${gameState.rules.z}倍でした！ )`;
  }

  const db = loadPlayerDb();
  gameState.players.forEach(p => {
    db[p.name] = (db[p.name] || 0) + p.score;
    p.savedTotalScore = db[p.name];
  });
  savePlayerDb(db);

  gameState.roundResultData = {
    roundNumber: gameState.currentRoundNum,
    declarerName: declarer.name,
    isReturned: isYanivReturned,
    summaryTitle: summaryTitle,
    summaryDesc: summaryDesc,
    playerRows: playerScoresData.map(ps => {
      const actualNode = gameState.players.find(p => p.id === ps.id);
      return {
        name: ps.name,
        handDetails: ps.handDetails,
        rawScore: ps.rawScore,
        isAI: false,
        isDeclarer: ps.isDeclarer,
        isGetter: ps.name === getterName,
        finalEarned: ps.finalEarned,
        totalAccumulated: actualNode ? (actualNode.savedTotalScore || 0) : 0
      };
    }),
    systemSystemLogs: [...gameState.roundHistory]
  };

  gameState.roundHistory = []; 
  gameState.status = 'round_end';
  
  io.emit('stateUpdate', gameState);
}

function removePlayerFromGame(targetId) {
  const pIndex = gameState.players.findIndex(p => p.id === targetId);
  if (pIndex === -1) return;

  const leavingPlayer = gameState.players[pIndex];
  io.emit('msgReceive', { sender: "システム", text: `${leavingPlayer.name}が途中離脱しました。` });

  if (leavingPlayer.hand && leavingPlayer.hand.length > 0) {
    gameState.discardPile.push(...leavingPlayer.hand);
  }

  gameState.players.splice(pIndex, 1);

  if (gameState.players.length === 0) {
    gameState.status = 'lobby';
    gameState.currentRoundNum = 1;
    io.emit('stateUpdate', gameState);
    return;
  }

  if (gameState.status === 'playing' || gameState.status === 'setting_rules') {
    if (gameState.buttonIndex >= gameState.players.length) { gameState.buttonIndex = 0; }
    if (gameState.currentTurn >= pIndex) { if (gameState.currentTurn > 0) gameState.currentTurn -= 1; }
    gameState.currentTurn = gameState.currentTurn % gameState.players.length;
    gameState.turnState = 'discard';
  }

  io.emit('stateUpdate', gameState);
}

io.on('connection', (socket) => {
  socket.emit('dbUpdate', loadPlayerDb());

  socket.on('msgSend', (data) => {
    io.emit('msgReceive', { sender: data.sender, text: data.text });
  });

  socket.on('leavePlayerAction', () => {
    removePlayerFromGame(socket.id);
    socket.emit('forceToLobby');
  });

  socket.on('resetDatabase', () => {
    const emptyDb = {};
    savePlayerDb(emptyDb);
    io.emit('dbUpdate', emptyDb);
    gameState.players.forEach(p => { p.savedTotalScore = 0; });
    io.emit('stateUpdate', gameState);
  });

  socket.on('joinGame', (name) => {
    if (gameState.status !== 'lobby' && gameState.status !== 'pre_start') return;
    const trimmedName = (name || '').trim() || `プレイヤー ${gameState.players.length + 1}`;
    const db = loadPlayerDb();
    gameState.players.push({ 
      id: socket.id, name: trimmedName, hand: [], score: 0, 
      savedTotalScore: db[trimmedName] || 0, isAI: false 
    });
    gameState.status = 'pre_start';
    io.emit('stateUpdate', gameState);
  });

  socket.on('confirmPreStart', () => {
    gameState.buttonIndex = 0;
    gameState.currentRoundNum = 1; 
    startNewRound();
  });

  socket.on('setRules', (rules) => {
    if (rules.isChaos) {
      let randX = 7;
      let randAny = false;
      if (Math.random() < (1 / 9)) {
        randAny = true;
      } else {
        const xList = [3, 4, 5, 6, 7, 8, 9, 10];
        randX = xList[Math.floor(Math.random() * xList.length)];
      }
      const randY = Math.floor(Math.random() * 20) + 1; 
      const randZ = Math.floor(Math.random() * 20) + 1; 

      gameState.rules = { x: randX, isAny: randAny, y: randY, z: randZ, isChaos: true };

      const announcer = gameState.players.find(p => p.id === socket.id);
      io.emit('msgSend', { 
        sender: "システム", 
        text: `⚠️ 親の ${announcer ? announcer.name : '誰か'} が【カオスモード（完全ランダム）】を発動！ 宣言条件は [${randAny ? 'Any' : randX + '点以下'}] です。倍率は勝負がつくまで非表示となります！` 
      });
    } else {
      gameState.rules = {
        x: parseInt(rules.x) || 7,
        isAny: !!rules.isAny,
        y: parseInt(rules.y) || 1,
        z: parseInt(rules.z) || 2,
        isChaos: false
      };
    }

    for (let player of gameState.players) {
      player.hand = []; 
      player.score = 0; 
      for (let i = 0; i < 5; i++) { player.hand.push(gameState.deck.pop()); }
    }

    let firstCard = gameState.deck.pop();
    while (firstCard.value === 0 || firstCard.value === 1) {
      gameState.deck.push(firstCard);
      for (let i = gameState.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
      }
      firstCard = gameState.deck.pop();
    }

    gameState.discardPile.push(firstCard);
    gameState.lastDiscardSet = [firstCard];
    gameState.status = 'playing';
    gameState.turnState = 'discard';
    gameState.currentTurn = (gameState.buttonIndex + 1) % gameState.players.length;
    io.emit('stateUpdate', gameState);
  });

  socket.on('discardCards', (data) => {
    const activePlayer = gameState.players[gameState.currentTurn];
    if (socket.id !== activePlayer.id) return;
    const { orderedDiscardIds } = data;
    gameState.pendingDiscard = [];
    for (let id of orderedDiscardIds) {
      const idx = activePlayer.hand.findIndex(c => c.id === id);
      if (idx !== -1) { gameState.pendingDiscard.push(activePlayer.hand.splice(idx, 1)[0]); }
    }
    gameState.turnState = 'draw';
    io.emit('stateUpdate', gameState);
  });

  socket.on('drawCard', (data) => {
    const activePlayer = gameState.players[gameState.currentTurn];
    if (socket.id !== activePlayer.id) return;
    const { drawSource, drawCardId } = data;
    let drawnCard;
    if (drawSource === 'discard' && drawCardId) {
      const idx = gameState.discardPile.findIndex(c => c.id === drawCardId);
      if (idx !== -1) { drawnCard = gameState.discardPile.splice(idx, 1)[0]; } 
      else { drawnCard = gameState.deck.pop(); }
    } else {
      drawnCard = gameState.deck.pop();
    }
    activePlayer.hand.push(drawnCard);
    processDrawEnd();
  });

  socket.on('declareYaniv', () => {
    executeYaniv(socket.id);
  });

  socket.on('nextRound', () => {
    gameState.currentRoundNum += 1; 
    gameState.buttonIndex = (gameState.buttonIndex + 1) % gameState.players.length;
    startNewRound();
  });

  socket.on('disconnect', () => {
    removePlayerFromGame(socket.id);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`ヤニブサーバー稼働中: http://localhost:${PORT}`);
});