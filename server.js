const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let gameState = {
  players: [],       // { id, name, hand: [], score: 0, isAI: true }
  deck: [],          
  discardPile: [],   
  lastDiscardSet: [], 
  pendingDiscard: [], 
  currentTurn: 0,    
  buttonIndex: 0,    
  status: 'lobby',   
  turnState: 'discard', 
  rules: { x: 7, y: 1, z: 2 },
  roundHistory: [],
  isSimulating: false,
  isFullAISim: false // ★ 完全AI自動シミュレーション中フラグ
};

// ★ シミュレーション用の累積統計データ
let simStats = {
  totalRounds: 0,
  yanivSuccessCount: 0,
  asafCount: 0,
  maxPointsInRound: 0,
  averageYanivScoreSum: 0, // ヤニブ宣言時の平均点数を出すための合計値
  totalDeclarations: 0,    // 宣言回数の合計
  aiWins: {
    'AI-スティーブ': 0,
    'AI-アリス': 0,
    'AI-ボブ': 0,
    'AI-キャロル': 0
  }
};

// トランプの作成とシャッフル
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
      score += isDeclarer ? 0 : 13;
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

// AI思考エンジン
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
      if (score > bestScore) {
        bestScore = score;
        bestSet = [...group];
      }
    }
  });

  const suitGroups = { 'S': [], 'H': [], 'D': [], 'C': [] };
  normalCards.forEach(c => suitGroups[c.suit].push(c));

  Object.keys(suitGroups).forEach(suit => {
    const cards = suitGroups[suit].sort((a, b) => a.value - b.value);
    for (let i = 0; i < cards.length; i++) {
      let seq = [cards[i]];
      for (let j = i + 1; j < cards.length; j++) {
        if (cards[j].value === seq[seq.length - 1].value + 1) {
          seq.push(cards[j]);
        } else if (cards[j].value === seq[seq.length - 1].value) {
          continue;
        } else {
          break;
        }
      }
      if (seq.length >= 3) {
        const score = calculateHandScore(seq, true);
        if (score > bestScore) {
          bestScore = score;
          bestSet = seq;
        }
      }
    }
  });

  if (jokers.length > 0 && bestSet.length > 0) {
    bestSet.push(jokers[0]);
  }

  if (bestSet.length === 0) {
    let highestCard = hand[0];
    for (let c of hand) {
      const cVal = c.value >= 10 ? 10 : (c.value === 0 ? 0 : c.value);
      const hVal = highestCard.value >= 10 ? 10 : (highestCard.value === 0 ? 0 : highestCard.value);
      if (cVal > hVal) {
        highestCard = c;
      }
    }
    bestSet = [highestCard];
  }

  return bestSet.map(c => c.id);
}

// 新しいラウンドを開始する共通関数
function startNewRound() {
  gameState.deck = createDeck();
  gameState.discardPile = [];
  gameState.lastDiscardSet = [];
  gameState.pendingDiscard = [];
  
  for (let p of gameState.players) { p.hand = []; }

  gameState.status = 'setting_rules';
  gameState.currentTurn = gameState.buttonIndex;
  io.emit('stateUpdate', gameState);
  io.emit('statsUpdate', simStats); // 統計データも同期
}

// 親(AI)の自動ルール確定
function autoSetRules() {
  if (gameState.status !== 'setting_rules') return;
  const buttonPlayer = gameState.players[gameState.buttonIndex];
  
  if (buttonPlayer && buttonPlayer.isAI) {
    gameState.rules = { x: 7, y: 1, z: 2 };

    for (let player of gameState.players) {
      for (let i = 0; i < 5; i++) {
        player.hand.push(gameState.deck.pop());
      }
    }

    const firstCard = gameState.deck.pop();
    gameState.discardPile.push(firstCard);
    gameState.lastDiscardSet = [firstCard];

    gameState.status = 'playing';
    gameState.turnState = 'discard';
    gameState.currentTurn = (gameState.buttonIndex + 1) % gameState.players.length;
    io.emit('stateUpdate', gameState);

    handleAIMove();
  }
}

// AI自動行動ハンドラー
function handleAIMove() {
  if (gameState.status !== 'playing' || !gameState.isSimulating) return;

  const activePlayer = gameState.players[gameState.currentTurn];
  if (!activePlayer || !activePlayer.isAI) return;

  // ★ 完全自動シミュレーション時はディレイを短く（0.3秒）して爆速で進めます
  const delay = gameState.isFullAISim ? 300 : 800;

  setTimeout(() => {
    if (gameState.status !== 'playing') return; // 防御策

    if (gameState.turnState === 'discard') {
      const score = calculateHandScore(activePlayer.hand, true);
      
      if (score <= gameState.rules.x) {
        console.log(`[AI] ${activePlayer.name} がヤニブを宣言！(手札点数: ${score})`);
        executeYaniv(activePlayer.id);
        return;
      }

      const discardIds = selectBestDiscard(activePlayer.hand);
      gameState.pendingDiscard = [];

      for (let id of discardIds) {
        const idx = activePlayer.hand.findIndex(c => c.id === id);
        if (idx !== -1) {
          gameState.pendingDiscard.push(activePlayer.hand.splice(idx, 1)[0]);
        }
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
        if (lastSet.length <= 2) {
          lastSet.forEach((_, idx) => playableIndices.push(idx));
        } else {
          playableIndices.push(0, lastSet.length - 1);
        }

        for (let idx of playableIndices) {
          const card = lastSet[idx];
          if (card && card.value > 0 && card.value <= 4) {
            drawSource = 'discard';
            drawCardId = card.id;
            break;
          }
        }
      }

      let drawnCard;
      if (drawSource === 'discard' && drawCardId) {
        const idx = gameState.discardPile.findIndex(c => c.id === drawCardId);
        if (idx !== -1) {
          drawnCard = gameState.discardPile.splice(idx, 1)[0];
        } else {
          drawnCard = gameState.deck.pop();
        }
      } else {
        drawnCard = gameState.deck.pop();
      }

      activePlayer.hand.push(drawnCard);

      gameState.discardPile.push(...gameState.pendingDiscard);
      gameState.lastDiscardSet = [...gameState.pendingDiscard];
      gameState.pendingDiscard = [];

      if (gameState.deck.length === 0) {
        const keepIds = new Set(gameState.lastDiscardSet.map(c => c.id));
        const newDeck = [];
        const newDiscard = [];
        for (let c of gameState.discardPile) {
          if (keepIds.has(c.id)) newDiscard.push(c);
          else newDeck.push(c);
        }
        gameState.deck = newDeck;
        for (let i = gameState.deck.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
        }
        gameState.discardPile = newDiscard;
      }

      gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
      gameState.turnState = 'discard';
      io.emit('stateUpdate', gameState);

      handleAIMove();
    }
  }, delay);
}

// ヤニブ実行のコアロジック
function executeYaniv(socketId) {
  const declarer = gameState.players.find(p => p.id === socketId);
  if (!declarer) return;

  const declarerScore = calculateHandScore(declarer.hand, true);
  let scores = gameState.players.map(p => {
    const isDecl = p.id === declarer.id;
    const rawScore = calculateHandScore(p.hand, isDecl);
    return {
      id: p.id,
      name: p.name,
      hand: [...p.hand],
      rawScore: rawScore,
      handDetails: p.hand.map(c => getCardString(c)).join(', ')
    };
  });

  const minScore = Math.min(...scores.map(s => s.rawScore));
  const maxScore = Math.max(...scores.map(s => s.rawScore));

  const rivalsWithLowerScore = scores.filter(s => s.id !== declarer.id && s.rawScore <= declarerScore);
  const isYanivReturned = rivalsWithLowerScore.length > 0;

  let getter = null;
  let reward = 0;
  let roundLogs = [];

  // ★【統計更新】
  simStats.totalRounds += 1;
  simStats.totalDeclarations += 1;
  simStats.averageYanivScoreSum += declarerScore;

  roundLogs.push("━━━━━━━━━━━━━━━━━━━━━━━━━");
  roundLogs.push("【全員の手札公開リザルト】");
  scores.forEach(s => {
    roundLogs.push(`・${s.name} : 手札 [ ${s.handDetails} ] ➔ 計 ${s.rawScore}点`);
  });
  roundLogs.push("━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (!isYanivReturned) {
    // ヤニブ成功
    getter = declarer;
    reward = (maxScore - minScore) * gameState.rules.y;
    getter.score += reward;
    
    // ★【統計更新】
    simStats.yanivSuccessCount += 1;
    if (simStats.aiWins[getter.name] !== undefined) simStats.aiWins[getter.name] += 1;

    roundLogs.push(`🎉 ${declarer.name} がヤニブ宣言に成功！ (手札: ${declarerScore}点)`);
    roundLogs.push(`🏆 ${declarer.name} が ${reward} ポイント獲得！ ((${maxScore} - ${minScore}) x ${gameState.rules.y}倍)`);
  } else {
    // ヤニブ返し（アサフ）発生
    const bestRival = rivalsWithLowerScore.reduce((prev, curr) => prev.rawScore < curr.rawScore ? prev : curr);
    getter = gameState.players.find(p => p.id === bestRival.id);
    reward = (maxScore - minScore) * gameState.rules.z;
    getter.score += reward;

    // ★【統計更新】
    simStats.asafCount += 1;
    if (simStats.aiWins[getter.name] !== undefined) simStats.aiWins[getter.name] += 1;

    roundLogs.push(`⚡ ヤニブ返し！ ${declarer.name} (手札: ${declarerScore}点) は阻止されました。`);
    roundLogs.push(`🏆 最低点 ${bestRival.rawScore}点 の ${getter.name} がゲッターとなり、${reward} ポイント獲得！ ((${maxScore} - ${minScore}) x ${gameState.rules.z}倍)`);
  }

  // ★ 最大一撃得点の記録
  if (reward > simStats.maxPointsInRound) {
    simStats.maxPointsInRound = reward;
  }

  gameState.roundHistory = roundLogs;
  gameState.status = 'round_end';
  io.emit('stateUpdate', gameState);
  io.emit('statsUpdate', simStats); // 最新の統計データをクライアントへ送る

  if (gameState.isSimulating) {
    // ★ 完全自動時は次のラウンド移行を1.2秒（人間が見学しやすい速度）で行い、サクサク進めます
    const transitionDelay = gameState.isFullAISim ? 1200 : 3000;
    setTimeout(() => {
      gameState.buttonIndex = (gameState.buttonIndex + 1) % gameState.players.length;
      startNewRound();
      
      setTimeout(() => {
        autoSetRules();
      }, 500);
    }, transitionDelay);
  }
}

// --- IO 接続処理（イベント登録） ---

io.on('connection', (socket) => {
  console.log(`接続確認: ${socket.id}`);

  // ★【新規】AIだけで対戦させデータを見る「完全自動AIシミュレーションモード」の開始
  socket.on('startFullAISimMode', () => {
    // 統計データのリセット
    simStats = {
      totalRounds: 0,
      yanivSuccessCount: 0,
      asafCount: 0,
      maxPointsInRound: 0,
      averageYanivScoreSum: 0,
      totalDeclarations: 0,
      aiWins: {
        'AI-スティーブ': 0,
        'AI-アリス': 0,
        'AI-ボブ': 0,
        'AI-キャロル': 0
      }
    };

    gameState.players = [];
    gameState.status = 'lobby';
    gameState.isSimulating = true;
    gameState.isFullAISim = true; // 完全AIモードに設定

    // AIプレイヤー4人（人間なし）
    const aiNames = ['AI-スティーブ', 'AI-アリス', 'AI-ボブ', 'AI-キャロル'];
    aiNames.forEach((name, idx) => {
      gameState.players.push({
        id: `AI-ID-${idx}`,
        name: name,
        hand: [],
        score: 0,
        isAI: true
      });
    });

    gameState.buttonIndex = 0;
    startNewRound();

    setTimeout(() => {
      autoSetRules();
    }, 500);
  });

  // 人間ありの通常シミュレーション
  socket.on('startSimMode', () => {
    gameState.players = [];
    gameState.status = 'lobby';
    gameState.isSimulating = true;
    gameState.isFullAISim = false;

    const aiNames = ['AI-スティーブ', 'AI-アリス', 'AI-ボブ', 'AI-キャロル'];
    aiNames.forEach((name, idx) => {
      gameState.players.push({
        id: `AI-ID-${idx}`,
        name: name,
        hand: [],
        score: 0,
        isAI: true
      });
    });

    gameState.players.push({
      id: socket.id,
      name: 'あなた（見学・介入可能）',
      hand: [],
      score: 0,
      isAI: false
    });

    gameState.buttonIndex = 0;
    startNewRound();

    setTimeout(() => {
      autoSetRules();
    }, 1000);
  });

  socket.on('joinGame', (name) => {
    if (gameState.status !== 'lobby') return;
    const trimmedName = (name || '').trim() || `プレイヤー ${gameState.players.length + 1}`;
    gameState.players.push({ id: socket.id, name: trimmedName, hand: [], score: 0, isAI: false });
    io.emit('stateUpdate', gameState);
  });

  socket.on('startGame', () => {
    if (gameState.players.length < 2) return;
    gameState.buttonIndex = 0;
    startNewRound();
  });

  socket.on('setRules', (rules) => {
    gameState.rules = {
      x: parseInt(rules.x) || 7,
      y: parseInt(rules.y) || 1,
      z: parseInt(rules.z) || 2
    };

    for (let player of gameState.players) {
      for (let i = 0; i < 5; i++) {
        player.hand.push(gameState.deck.pop());
      }
    }

    const firstCard = gameState.deck.pop();
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
      if (idx !== -1) {
        gameState.pendingDiscard.push(activePlayer.hand.splice(idx, 1)[0]);
      }
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
      if (idx !== -1) {
        drawnCard = gameState.discardPile.splice(idx, 1)[0];
      } else {
        drawnCard = gameState.deck.pop();
      }
    } else {
      drawnCard = gameState.deck.pop();
    }

    activePlayer.hand.push(drawnCard);

    gameState.discardPile.push(...gameState.pendingDiscard);
    gameState.lastDiscardSet = [...gameState.pendingDiscard];
    gameState.pendingDiscard = [];

    if (gameState.deck.length === 0) {
      const keepIds = new Set(gameState.lastDiscardSet.map(c => c.id));
      const newDeck = [];
      const newDiscard = [];
      for (let c of gameState.discardPile) {
        if (keepIds.has(c.id)) newDiscard.push(c);
        else newDeck.push(c);
      }
      gameState.deck = newDeck;
      for (let i = gameState.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [gameState.deck[i], gameState.deck[j]] = [gameState.deck[j], gameState.deck[i]];
      }
      gameState.discardPile = newDiscard;
    }

    gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
    gameState.turnState = 'discard';
    io.emit('stateUpdate', gameState);

    handleAIMove();
  });

  socket.on('declareYaniv', () => {
    executeYaniv(socket.id);
  });

  socket.on('nextRound', () => {
    gameState.buttonIndex = (gameState.buttonIndex + 1) % gameState.players.length;
    startNewRound();
  });

  socket.on('disconnect', () => {
    gameState.players = gameState.players.filter(p => p.id !== socket.id);
    if (gameState.players.length === 0) {
      gameState.status = 'lobby';
      gameState.isSimulating = false;
      gameState.isFullAISim = false;
    }
    io.emit('stateUpdate', gameState);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`ヤニブサーバー稼働中: http://localhost:${PORT}`);
});