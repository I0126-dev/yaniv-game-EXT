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
  rules: { x: 7, isAny: false, y: 1, z: 2 }, 
  roundHistory: [],
  isSimulating: false,
  isFullAISim: false,
  reshuffleCount: 0,
  currentRoundNum: 1,
  roundResultData: null
};

let simStats = {
  totalRounds: 0,
  yanivSuccessCount: 0,
  asafCount: 0,
  maxPointsInRound: 0,
  averageYanivScoreSum: 0,
  totalDeclarations: 0,
  aiWins: { 'AI-スティーブ': 0, 'AI-アリス': 0, 'AI-ボブ': 0, 'AI-キャロル': 0 }
};

// ★【新設】AI戦の自動進行タイマーの暴走を止めるためのグローバル管理変数
let aiNextRoundTimer = null;

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

function selectBestDiscard(hand) {
  const jokers = hand.filter(c => c.value === 0);
  const normalCards = hand.filter(c => c.value !== 0);
  const valueGroups = {};
  normalCards.forEach(c => {
    if (!valueGroups[c.value]) valueGroups[c.value] = [];
    valueGroups[c.value].push(c);
  });
  let bestSet = [];
  let bestScore = -1;
  Object.keys(valueGroups).forEach(val => {
    const group = valueGroups[val];
    if (group.length >= 2) {
      const score = calculateHandScore(group, true);
      if (score > bestScore) { bestScore = score; bestSet = [...group]; }
    }
  });
  const suitGroups = { 'S': [], 'H': [], 'D': [], 'C': [] };
  normalCards.forEach(c => suitGroups[c.suit].push(c));
  Object.keys(suitGroups).forEach(suit => {
    const cards = suitGroups[suit].sort((a, b) => a.value - b.value);
    for (let i = 0; i < cards.length; i++) {
      let seq = [cards[i]];
      for (let j = i + 1; j < cards.length; j++) {
        if (cards[j].value === seq[seq.length - 1].value + 1) { seq.push(cards[j]); }
        else if (cards[j].value === seq[seq.length - 1].value) { continue; }
        else { break; }
      }
      if (seq.length >= 3) {
        const score = calculateHandScore(seq, true);
        if (score > bestScore) { bestScore = score; bestSet = seq; }
      }
    }
  });
  if (jokers.length > 0 && bestSet.length > 0) { bestSet.push(jokers[0]); }
  if (bestSet.length === 0) {
    let highestCard = hand[0];
    for (let c of hand) {
      const cVal = c.value >= 10 ? 10 : (c.value === 0 ? 0 : c.value);
      const hVal = highestCard.value >= 10 ? 10 : (highestCard.value === 0 ? 0 : highestCard.value);
      if (cVal > hVal) { highestCard = c; }
    }
    bestSet = [highestCard];
  }
  return bestSet.map(c => c.id);
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
  io.emit('statsUpdate', simStats);
}

function autoSetRules() {
  if (gameState.status !== 'setting_rules') return;
  const buttonPlayer = gameState.players[gameState.buttonIndex];
  if (buttonPlayer && buttonPlayer.isAI) {
    
    let chosenX = 7;
    let chosenAny = false;
    if (Math.random() < 0.2) {
      chosenAny = true;
    } else {
      const xOptions = [5, 6, 7, 8, 9, 10];
      chosenX = xOptions[Math.floor(Math.random() * xOptions.length)];
    }

    const yOptions = [6, 7, 8, 9, 10];
    let chosenY = yOptions[Math.floor(Math.random() * yOptions.length)];

    const zOptions = [6, 7, 8, 9, 10];
    let chosenZ = zOptions[Math.floor(Math.random() * zOptions.length)];

    gameState.rules = { x: chosenX, isAny: chosenAny, y: chosenY, z: chosenZ };
    
    const ruleLogText = chosenAny 
      ? `親の ${buttonPlayer.name} が特殊ルール [Any (いつでもヤニブOK) / 通常${chosenY}倍 / 返し${chosenZ}倍] を宣告しました！`
      : `親の ${buttonPlayer.name} がルール [X値: ${chosenX}点以下 / 通常${chosenY}倍 / 返し${chosenZ}倍] を設定しました。`;
    io.emit('msgSend', { sender: "システム", text: ruleLogText });
    
    for (let player of gameState.players) {
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
    handleAIMove();
  }
}

function handleAIMove() {
  if (gameState.status !== 'playing' || !gameState.isSimulating) return;
  const activePlayer = gameState.players[gameState.currentTurn];
  if (!activePlayer || !activePlayer.isAI) return;
  const delay = gameState.isFullAISim ? 300 : 800;

  setTimeout(() => {
    if (gameState.status !== 'playing') return;
    if (gameState.turnState === 'discard') {
      const score = calculateHandScore(activePlayer.hand, true);
      const threshold = gameState.rules.isAny ? 10 : gameState.rules.x;
      if (score <= threshold) {
        executeYaniv(activePlayer.id);
        return;
      }

      const discardIds = selectBestDiscard(activePlayer.hand);
      gameState.pendingDiscard = [];
      for (let id of discardIds) {
        const idx = activePlayer.hand.findIndex(c => c.id === id);
        if (idx !== -1) { gameState.pendingDiscard.push(activePlayer.hand.splice(idx, 1)[0]); }
      }
      gameState.turnState = 'draw';
      io.emit('stateUpdate', gameState);
      handleAIMove();
    } 
    else if (gameState.turnState === 'draw') {
      let drawSource = 'deck';
      let drawCardId = null;
      const lastSet = gameState.lastDiscardSet || [];
      if (lastSet.length > 0) {
        const playableIndices = [];
        if (lastSet.length <= 2) { lastSet.forEach((_, idx) => playableIndices.push(idx)); } 
        else { playableIndices.push(0, lastSet.length - 1); }
        for (let idx of playableIndices) {
          const card = lastSet[idx];
          if (card && card.value > 0 && card.value <= 4) {
            drawSource = 'discard'; drawCardId = card.id; break;
          }
        }
      }
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
    }
  }, delay);
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
  if (gameState.isSimulating) { handleAIMove(); }
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
      isAI: p.isAI,
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

  simStats.totalRounds += 1;
  simStats.totalDeclarations += 1;
  simStats.averageYanivScoreSum += declarerScore;

  io.emit('yanivAlert', { announcer: declarer.name, isReturned: isYanivReturned });

  if (!isYanivReturned) {
    const targetNode = gameState.players.find(p => p.id === declarer.id);
    reward = (maxScore - minScore) * gameState.rules.y;
    targetNode.score = reward;
    getterName = declarer.name;
    
    playerScoresData.find(s => s.id === declarer.id).finalEarned = reward;
    simStats.yanivSuccessCount += 1;
    if (simStats.aiWins[getterName] !== undefined) {
      simStats.aiWins[getterName] += 1;
    }
    summaryTitle = `🎉 ${declarer.name} のヤニブ成功！`;
    summaryDesc = `手札点数 ${declarerScore}点 で安全に逃げ切りました。ゲッター報酬として [${reward} pt] を獲得します。`;
  } else {
    const bestRival = rivalsWithLowerScore.reduce((prev, curr) => prev.rawScore < curr.rawScore ? prev : curr);
    const targetNode = gameState.players.find(p => p.id === bestRival.id);
    reward = (maxScore - minScore) * gameState.rules.y * gameState.rules.z;
    targetNode.score = reward;
    getterName = bestRival.name;

    playerScoresData.find(s => s.id === bestRival.id).finalEarned = reward;
    simStats.asafCount += 1;
    if (simStats.aiWins[getterName] !== undefined) {
      simStats.aiWins[getterName] += 1;
    }
    summaryTitle = `⚡ ヤニブ返し発生！阻止成功！`;
    summaryDesc = `${declarer.name} の宣言ラインを、さらに低い手札（${bestRival.rawScore}点）の ${bestRival.name} が迎撃！ペナルティ倍率が適用され、${bestRival.name} が [${reward} pt] を強奪しました。`;
  }

  if (reward > simStats.maxPointsInRound) { simStats.maxPointsInRound = reward; }

  if (!gameState.isSimulating) {
    const db = loadPlayerDb();
    gameState.players.forEach(p => {
      if (!p.isAI) {
        db[p.name] = (db[p.name] || 0) + p.score;
        p.savedTotalScore = db[p.name];
      }
    });
    savePlayerDb(db);
  }

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
        isAI: ps.isAI,
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
  
  io.emit('statsUpdate', simStats);
  io.emit('stateUpdate', gameState);

  if (gameState.isSimulating) {
    const transitionDelay = gameState.isFullAISim ? 1200 : 3000;
    
    // ★【バグ修正】既存タイマーがあれば念のためクリア
    if (aiNextRoundTimer) clearTimeout(aiNextRoundTimer);

    // タイマーIDを変数に保持
    aiNextRoundTimer = setTimeout(() => {
      if (!gameState.isSimulating || gameState.status !== 'round_end') return;
      
      gameState.currentRoundNum += 1; 
      gameState.buttonIndex = (gameState.buttonIndex + 1) % gameState.players.length;
      startNewRound();
      
      setTimeout(() => { 
        autoSetRules(); 
      }, 500);
    }, transitionDelay);
  }
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
    // タイマー破壊
    if (aiNextRoundTimer) { clearTimeout(aiNextRoundTimer); aiNextRoundTimer = null; }
    gameState.status = 'lobby';
    gameState.isSimulating = false;
    gameState.isFullAISim = false;
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
  if (gameState.status === 'playing' && gameState.isSimulating) { handleAIMove(); }
}

io.on('connection', (socket) => {
  socket.emit('dbUpdate', loadPlayerDb());

  socket.on('msgSend', (data) => {
    io.emit('msgReceive', { sender: data.sender, text: data.text });
  });

  socket.on('startFullAISimMode', () => {
    if (aiNextRoundTimer) { clearTimeout(aiNextRoundTimer); aiNextRoundTimer = null; }
    simStats = {
      totalRounds: 0, yanivSuccessCount: 0, asafCount: 0, maxPointsInRound: 0,
      averageYanivScoreSum: 0, totalDeclarations: 0,
      aiWins: { 'AI-スティーブ': 0, 'AI-アリス': 0, 'AI-ボブ': 0, 'AI-キャロル': 0 }
    };
    gameState.players = [];
    gameState.status = 'lobby';
    gameState.isSimulating = true;
    gameState.isFullAISim = true;
    gameState.currentRoundNum = 1;

    const aiNames = ['AI-スティーブ', 'AI-アリス', 'AI-ボブ', 'AI-キャロル'];
    aiNames.forEach((name, idx) => {
      gameState.players.push({ id: `AI-ID-${idx}`, name: name, hand: [], score: 0, isAI: true });
    });
    gameState.buttonIndex = 0;
    startNewRound();
    setTimeout(() => { autoSetRules(); }, 500);
  });

  socket.on('startSimMode', () => {
    if (aiNextRoundTimer) { clearTimeout(aiNextRoundTimer); aiNextRoundTimer = null; }
    gameState.players = [];
    gameState.status = 'lobby';
    gameState.isSimulating = true;
    gameState.isFullAISim = false;
    gameState.currentRoundNum = 1;

    const aiNames = ['AI-スティーブ', 'AI-アリス', 'AI-ボブ', 'AI-キャロル'];
    aiNames.forEach((name, idx) => {
      gameState.players.push({ id: `AI-ID-${idx}`, name: name, hand: [], score: 0, isAI: true });
    });
    gameState.players.push({ id: socket.id, name: 'あなた（見学・介入可能）', hand: [], score: 0, isAI: false });
    gameState.buttonIndex = 0;
    startNewRound();
    setTimeout(() => { autoSetRules(); }, 1000);
  });

  // ★【重要バグ修正】人間からシミュレーション強制終了シグナルが来たら、次のラウンドへ進むタイマーを最優先で即座に完全破壊・リセットする
  socket.on('stopSimulation', () => {
    if (aiNextRoundTimer) {
      clearTimeout(aiNextRoundTimer);
      aiNextRoundTimer = null;
    }
    gameState.isSimulating = false;
    gameState.isFullAISim = false;
    gameState.status = 'lobby';
    gameState.players = [];
    gameState.currentRoundNum = 1;
    io.emit('stateUpdate', gameState);
    io.emit('dbUpdate', loadPlayerDb());
  });

  socket.on('leavePlayerAction', () => {
    removePlayerFromGame(socket.id);
    socket.emit('forceToLobby');
  });

  socket.on('resetDatabase', () => {
    const emptyDb = {};
    savePlayerDb(emptyDb);
    io.emit('dbUpdate', emptyDb);
    gameState.players.forEach(p => { if (!p.isAI) p.savedTotalScore = 0; });
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
    gameState.rules = {
      x: parseInt(rules.x) || 7,
      isAny: !!rules.isAny,
      y: parseInt(rules.y) || 1,
      z: parseInt(rules.z) || 2
    };
    for (let player of gameState.players) {
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
    handleAIMove();
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