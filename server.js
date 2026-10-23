import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// 静的ファイルの提供（ルート直下のindex.htmlおよびpublic）
app.use(express.static(__dirname));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 複数部屋（ルーム）の管理
// key: roomId (文字列 例: "1000", "7842")
// value: roomState オブジェクト
const rooms = new Map();

function createRoomState(roomId) {
  return {
    roomId: roomId,
    hostToken: null,
    hostId: null,
    players: [], // { id, token, name, isOnline, scoreCards: [], eventCards: [], disconnectedAt }
    currentTurnIndex: 0,
    isGameStarted: false,
    isGameOver: false,
    pendingDiscardPlayerId: null,
    pendingSurvey: null, // { playerId, candidates: [] }
    pendingTrade: null,  // { playerId }
    pendingReveal: null, // { playerId }
    decks: { actionDeck: [], mineDeck: [], eventDeck: [] },
    discardActionDeck: [], // 使用済み行動カード
    logs: [`⛏️ 部屋番号【${roomId}】が作成されました！`],
    createdAt: Date.now()
  };
}

function getOrCreateRoom(roomId) {
  const cleanId = String(roomId || '1000')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 10) || '1000';

  if (!rooms.has(cleanId)) {
    rooms.set(cleanId, createRoomState(cleanId));
  }
  return rooms.get(cleanId);
}

function getRoom(roomId) {
  if (!roomId) return null;
  const cleanId = String(roomId).trim().toUpperCase();
  return rooms.get(cleanId) || null;
}

function initializeDecks() {
  // 鉱山: 33枚 (石炭1点x15, 金2点x10, ダイヤ3点x5, 爆弾x3)
  let mine = [];
  for (let i = 0; i < 15; i++) mine.push({ type: 'score', name: '石炭', value: 1 });
  for (let i = 0; i < 10; i++) mine.push({ type: 'score', name: '金', value: 2 });
  for (let i = 0; i < 5; i++) mine.push({ type: 'score', name: 'ダイヤ', value: 3 });
  for (let i = 0; i < 3; i++) mine.push({ type: 'bomb', name: '爆弾', value: 0 });

  // 行動: 20枚 (つるはし:ドリル = 7:3 -> つるはしx14, ドリルx6)
  let action = [];
  for (let i = 0; i < 14; i++) action.push('つるはし');
  for (let i = 0; i < 6; i++) action.push('ドリル');

  // イベント: 15枚 (爆破x2, 賄賂x2, 山分けx1, 公開x2, 強奪x3, 取引x3, 調査x2)
  let eventList = [
    { id: 'blast', name: '爆破' }, { id: 'blast', name: '爆破' },
    { id: 'bribe', name: '賄賂' }, { id: 'bribe', name: '賄賂' },
    { id: 'share', name: '山分け' },
    { id: 'reveal', name: '公開' }, { id: 'reveal', name: '公開' },
    { id: 'rob', name: '強奪' }, { id: 'rob', name: '強奪' }, { id: 'rob', name: '強奪' },
    { id: 'trade', name: '取引' }, { id: 'trade', name: '取引' }, { id: 'trade', name: '取引' },
    { id: 'survey', name: '調査' }, { id: 'survey', name: '調査' }
  ];

  return {
    mineDeck: shuffle(mine),
    actionDeck: shuffle(action),
    eventDeck: shuffle(eventList)
  };
}

function addEventCardToPlayer(room, player, evCard) {
  player.eventCards.push(evCard);
  if (player.eventCards.length > 4) {
    room.pendingDiscardPlayerId = player.id;
    return false;
  }
  return true;
}

function shuffle(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getLobbyStatus(room) {
  if (!room) return { roomId: '', playerCount: 0, players: [], isGameStarted: false, disconnectedPlayers: [] };

  // ホストの妥当性確認と再割当
  ensureValidHost(room);

  return {
    roomId: room.roomId,
    hostToken: room.hostToken,
    hostId: room.hostId,
    playerCount: room.players.length,
    players: room.players.map(p => ({
      id: p.id,
      token: p.token,
      name: p.name,
      isOnline: p.isOnline !== false,
      isHost: (p.token === room.hostToken || p.id === room.hostId)
    })),
    isGameStarted: room.isGameStarted,
    disconnectedPlayers: room.players
      .filter(p => p.isOnline === false)
      .map(p => ({ name: p.name, token: p.token }))
  };
}

function ensureValidHost(room) {
  if (!room || room.players.length === 0) {
    room.hostToken = null;
    room.hostId = null;
    return;
  }

  const currentHost = room.players.find(p => p.token === room.hostToken);
  // ホストが既にいない場合、オンラインプレイヤーを優先してホストに任命
  if (!currentHost) {
    const onlineP = room.players.find(p => p.isOnline !== false) || room.players[0];
    room.hostToken = onlineP.token;
    room.hostId = onlineP.id;
  } else if (currentHost.isOnline === false) {
    // ホストが切断中の場合、オンラインのプレイヤーがいれば一時的または恒久的にホスト権限を引き継ぐ
    const onlineP = room.players.find(p => p.isOnline !== false);
    if (onlineP) {
      room.hostToken = onlineP.token;
      room.hostId = onlineP.id;
    }
  }
}

function broadcastState(room, extraData = null) {
  if (!room) return;
  ensureValidHost(room);

  const currentTurnPlayer = room.players[room.currentTurnIndex];
  const discardPlayer = room.players.find(pl => pl.id === room.pendingDiscardPlayerId);
  const surveyPlayer = room.pendingSurvey ? room.players.find(pl => pl.id === room.pendingSurvey.playerId) : null;
  const tradePlayer = room.pendingTrade ? room.players.find(pl => pl.id === room.pendingTrade.playerId) : null;
  const revealPlayer = room.pendingReveal ? room.players.find(pl => pl.id === room.pendingReveal.playerId) : null;

  room.players.forEach(p => {
    const opponentsList = room.players
      .filter(other => (other.token ? other.token !== p.token : other.id !== p.id))
      .map(other => ({
        id: other.id,
        token: other.token,
        name: other.name,
        scoreCardCount: other.scoreCards.length,
        eventCardCount: other.eventCards.length,
        isCurrentTurn: currentTurnPlayer && (currentTurnPlayer.id === other.id || (other.token && currentTurnPlayer.token === other.token)),
        isOnline: other.isOnline !== false,
        isHost: (other.token === room.hostToken || other.id === room.hostId)
      }));

    const playerLogs = room.logs.slice(-30).map(logItem => {
      if (typeof logItem === 'string') return logItem;
      if (logItem && typeof logItem === 'object') {
        if (logItem.playerId === p.id && logItem.privateText) {
          return logItem.privateText;
        }
        return logItem.publicText || '';
      }
      return String(logItem);
    });

    const isHost = (p.token === room.hostToken || p.id === room.hostId);
    const hostPlayer = room.players.find(pl => pl.token === room.hostToken);

    const clientState = {
      roomId: room.roomId,
      myId: p.id,
      myToken: p.token,
      isHost: isHost,
      hostName: hostPlayer ? hostPlayer.name : null,
      isOnline: p.isOnline !== false,
      isGameStarted: room.isGameStarted,
      playerCount: room.players.length,
      allPlayerNames: room.players.map(pl => pl.name),
      allPlayers: room.players.map(pl => ({
        id: pl.id,
        token: pl.token,
        name: pl.name,
        isOnline: pl.isOnline !== false,
        isHost: (pl.token === room.hostToken || pl.id === room.hostId)
      })),
      currentTurnPlayerName: currentTurnPlayer ? currentTurnPlayer.name : null,
      currentTurnPlayerIsOnline: currentTurnPlayer ? currentTurnPlayer.isOnline !== false : true,
      currentTurnIndex: room.currentTurnIndex,
      turnOrder: room.players.map(pl => pl.name),
      myHand: { scoreCards: p.scoreCards, eventCards: p.eventCards },
      opponents: opponentsList,
      deckCounts: {
        mine: room.decks.mineDeck ? room.decks.mineDeck.length : 0,
        action: room.decks.actionDeck ? room.decks.actionDeck.length : 0,
        event: room.decks.eventDeck ? room.decks.eventDeck.length : 0
      },
      isMyTurn: currentTurnPlayer && (currentTurnPlayer.id === p.id || (p.token && currentTurnPlayer.token === p.token)),
      mustDiscard: room.pendingDiscardPlayerId === p.id,
      pendingDiscardPlayerId: room.pendingDiscardPlayerId,
      pendingDiscardPlayerName: discardPlayer ? discardPlayer.name : null,
      isSurveying: room.pendingSurvey ? room.pendingSurvey.playerId === p.id : false,
      pendingSurveyPlayerName: surveyPlayer ? surveyPlayer.name : null,
      isTrading: room.pendingTrade ? room.pendingTrade.playerId === p.id : false,
      pendingTradePlayerName: tradePlayer ? tradePlayer.name : null,
      isRevealing: room.pendingReveal ? room.pendingReveal.playerId === p.id : false,
      pendingRevealPlayerName: revealPlayer ? revealPlayer.name : null,
      logs: playerLogs,
      extraData: extraData
    };

    if (p.isOnline !== false && p.id) {
      io.to(p.id).emit('state_update', clientState);
    }
  });
}

function nextTurn(room) {
  if (!room || room.players.length === 0) return;
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
  broadcastState(room);
}

function drawFromMine(room, player, count) {
  let drawn = [];
  for (let i = 0; i < count; i++) {
    if (room.decks.mineDeck.length > 0) {
      const c = room.decks.mineDeck.pop();
      player.scoreCards.push(c);
      drawn.push(c);
    }
  }
  return drawn;
}

// 鉱山切れまたは鉱石全枯渇の判定
function checkMineDepletion(room) {
  if (!room) return false;
  if (room.decks.mineDeck.length === 0) {
    endGame(room, 'empty');
    return true;
  }
  // 鉱山に残っているカードがすべて爆弾（鉱石がすべて採掘された場合）
  const hasOre = room.decks.mineDeck.some(c => c.type !== 'bomb');
  if (!hasOre) {
    endGame(room, 'only_bombs');
    return true;
  }
  return false;
}

function endGame(room, reason) {
  if (!room || room.isGameOver) return;
  room.isGameOver = true;

  room.logs.push('===================');
  const isAllMined = reason === 'only_bombs' || (room.decks.mineDeck && room.decks.mineDeck.length > 0 && room.decks.mineDeck.every(c => c.type === 'bomb'));
  if (isAllMined) {
    room.logs.push('鉱山から鉱石がすべて採りつくされました！');
  } else {
    room.logs.push('鉱山がなくなりました！ゲーム終了！');
  }

  // 裏技判定: 爆弾3枚、爆破2枚を所持してゲームを終了したプレイヤーがいるか？
  const trickPlayer = room.players.find(p => {
    const bCount = (p.scoreCards || []).filter(c => c.type === 'bomb').length;
    const blastCount = (p.eventCards || []).filter(c => c.id === 'blast' || c.name === '爆破').length;
    return bCount >= 3 && blastCount >= 2;
  });

  if (trickPlayer) {
    room.logs.push('💥💥💥【裏技発動！超大爆破】💥💥💥');
    room.logs.push(`⚠️ 【${trickPlayer.name}】が「爆弾3枚」と「爆破2枚」を所持！連鎖大爆発により、自分以外のプレイヤーの得点カードがすべて破壊されました！`);
  }

  // 勝敗計算＆爆弾処理
  let results = room.players.map(p => {
    let cards = [...p.scoreCards];
    const bombCount = cards.filter(c => c.type === 'bomb').length;
    const blastCount = (p.eventCards || []).filter(c => c.id === 'blast' || c.name === '爆破').length;
    const isTrickUser = !!(trickPlayer && p.id === trickPlayer.id);
    const isTrickVictim = !!(trickPlayer && p.id !== trickPlayer.id);
    let destroyedCards = [];

    // 爆弾判定前の暫定得点
    let initialScore = p.scoreCards.reduce((sum, c) => sum + (typeof c.value === 'number' && c.type !== 'bomb' ? c.value : 0), 0);

    if (isTrickVictim) {
      // 裏技により、自分以外のプレイヤーの得点カードをすべて破壊！
      destroyedCards = cards.filter(c => c.type !== 'bomb');
      cards = cards.filter(c => c.type === 'bomb'); // 得点カード全滅
    } else {
      // 爆弾所持の場合、爆弾の枚数分だけダイヤ ➔ 金 ➔ 石炭の順に優先的に破壊
      for (let b = 0; b < bombCount; b++) {
        const priorityOrder = ['ダイヤ', '金', '石炭'];
        let targetIdx = -1;

        for (const cardName of priorityOrder) {
          targetIdx = cards.findIndex(c => c.type !== 'bomb' && c.name === cardName);
          if (targetIdx !== -1) break;
        }

        // フォールバック: 点数の高い順
        if (targetIdx === -1) {
          let maxVal = -1;
          cards.forEach((c, idx) => {
            if (c.type !== 'bomb' && typeof c.value === 'number' && c.value > maxVal) {
              maxVal = c.value;
              targetIdx = idx;
            }
          });
        }

        if (targetIdx !== -1) {
          const removed = cards.splice(targetIdx, 1)[0];
          destroyedCards.push(removed);
        } else {
          break; // 破壊できる得点カードがなくなった場合
        }
      }
    }

    // 爆弾処理後の最終得点集計 (爆弾は0点扱い)
    let finalScore = cards.reduce((sum, c) => sum + (typeof c.value === 'number' && c.type !== 'bomb' ? c.value : 0), 0);
    return {
      id: p.id,
      name: p.name,
      initialScore: initialScore,
      finalScore: finalScore,
      score: finalScore, // 後方互換用
      hasBomb: bombCount > 0,
      bombCount: bombCount,
      blastCount: blastCount,
      isTrickUser: isTrickUser,
      isTrickVictim: isTrickVictim,
      destroyedCards: destroyedCards.map(c => ({ name: c.name, value: c.value })),
      destroyedCard: destroyedCards[0] ? { name: destroyedCards[0].name, value: destroyedCards[0].value } : null,
      totalDeductedScore: initialScore - finalScore,
      originalCount: p.scoreCards.length
    };
  });

  // 最高得点者判定 (同点は全員勝利)
  let maxScore = Math.max(...results.map(r => r.finalScore), 0);
  let winners = results.filter(r => r.finalScore === maxScore).map(r => r.name);

  room.logs.push(`勝者: ${winners.join(', ')} (得点: ${maxScore}点)`);
  broadcastState(room, {
    gameOver: true,
    reason: isAllMined ? 'only_bombs' : 'empty',
    endMessage: isAllMined ? '鉱山から鉱石がすべて採りつくされました！' : '鉱山がなくなりました！ゲーム終了！',
    secretTrickActivated: !!trickPlayer,
    secretTrickPlayerName: trickPlayer ? trickPlayer.name : null,
    results: results,
    winners: winners,
    maxScore: maxScore
  });
}

io.on('connection', (socket) => {
  // 部屋情報取得要求
  socket.on('query_room_lobby', (payload) => {
    const roomId = (payload && payload.roomId) ? payload.roomId : '1000';
    const room = getRoom(roomId);
    socket.emit('lobby_status', getLobbyStatus(room || { roomId, players: [], isGameStarted: false }));
  });

  function handlePlayerJoinOrReconnect(payload) {
    let playerName = '';
    let clientToken = null;
    let targetRoomId = '1000';

    if (typeof payload === 'string') {
      playerName = payload.trim();
    } else if (payload && typeof payload === 'object') {
      playerName = (payload.name || '').trim();
      clientToken = payload.token || null;
      if (payload.roomId) {
        targetRoomId = String(payload.roomId).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 10) || '1000';
      }
    }

    const room = getOrCreateRoom(targetRoomId);

    // 部屋移動時の古いルーム脱退
    if (socket.roomId && socket.roomId !== room.roomId) {
      socket.leave(socket.roomId);
    }
    socket.join(room.roomId);
    socket.roomId = room.roomId;

    // 1. 既存プレイヤーの復帰判定 (Token一致、または同名で切断中、またはゲーム進行中同名)
    let existingPlayer = null;
    if (clientToken) {
      existingPlayer = room.players.find(p => p.token === clientToken);
    }
    if (!existingPlayer && playerName) {
      existingPlayer = room.players.find(p => p.name === playerName && p.isOnline === false);
      if (!existingPlayer && room.isGameStarted) {
        existingPlayer = room.players.find(p => p.name === playerName);
      }
    }

    if (existingPlayer) {
      const oldSocketId = existingPlayer.id;
      existingPlayer.id = socket.id;
      if (clientToken && !existingPlayer.token) {
        existingPlayer.token = clientToken;
      }
      socket.playerToken = existingPlayer.token;
      socket.playerName = existingPlayer.name;
      existingPlayer.isOnline = true;
      existingPlayer.disconnectedAt = null;

      // 保留アクションの socket.id を更新
      if (room.pendingDiscardPlayerId === oldSocketId) {
        room.pendingDiscardPlayerId = socket.id;
      }
      if (room.pendingSurvey && room.pendingSurvey.playerId === oldSocketId) {
        room.pendingSurvey.playerId = socket.id;
      }
      if (room.pendingTrade && room.pendingTrade.playerId === oldSocketId) {
        room.pendingTrade.playerId = socket.id;
      }
      if (room.pendingReveal && room.pendingReveal.playerId === oldSocketId) {
        room.pendingReveal.playerId = socket.id;
      }

      // ホストIDも更新
      if (existingPlayer.token === room.hostToken) {
        room.hostId = socket.id;
      }

      room.logs.push(`🔄 ${existingPlayer.name} が部屋【${room.roomId}】に復帰しました！`);

      socket.emit('join_success', {
        roomId: room.roomId,
        name: existingPlayer.name,
        token: existingPlayer.token,
        isHost: (existingPlayer.token === room.hostToken || existingPlayer.id === room.hostId),
        isRejoin: true,
        isGameStarted: room.isGameStarted
      });

      // 調査イベントの選択待ちだった場合は選択肢を再送
      if (room.pendingSurvey && room.pendingSurvey.playerId === socket.id) {
        socket.emit('survey_options', {
          candidates: room.pendingSurvey.candidates.map((c, idx) => ({
            idx,
            type: c.type,
            name: c.name,
            value: c.value
          }))
        });
      }

      // 取引イベントの選択待ちだった場合はダイアログ再送
      if (room.pendingTrade && room.pendingTrade.playerId === socket.id) {
        socket.emit('trade_select_dialog');
      }

      broadcastState(room);
      io.to(room.roomId).emit('lobby_status', getLobbyStatus(room));
      return;
    }

    // 2. 新規参加判定
    if (room.isGameStarted) {
      return socket.emit('error_message', 'この部屋はゲーム進行中のため新規参加はできません（退席中のプレイヤー名で復帰するか、別の部屋番号をご利用ください）');
    }

    if (room.players.length >= 5) {
      return socket.emit('error_message', `部屋【${room.roomId}】は満員です（最大5名）`);
    }

    const cleanName = playerName || `プレイヤー${room.players.length + 1}`;
    const newToken = clientToken || ('tok_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    const newPlayer = {
      id: socket.id,
      token: newToken,
      name: cleanName,
      isOnline: true,
      scoreCards: [],
      eventCards: []
    };

    // 最初のプレイヤーをホストに設定
    if (room.players.length === 0 || !room.hostToken) {
      room.hostToken = newToken;
      room.hostId = socket.id;
    }

    socket.playerToken = newToken;
    socket.playerName = cleanName;

    room.players.push(newPlayer);
    room.logs.push(`${newPlayer.name} が入室しました（計${room.players.length}名）`);

    socket.emit('join_success', {
      roomId: room.roomId,
      name: newPlayer.name,
      token: newPlayer.token,
      isHost: (newPlayer.token === room.hostToken || newPlayer.id === room.hostId),
      isRejoin: false,
      isGameStarted: false
    });

    broadcastState(room);
    io.to(room.roomId).emit('lobby_status', getLobbyStatus(room));
  }

  socket.on('join_game', handlePlayerJoinOrReconnect);
  socket.on('reconnect_player', handlePlayerJoinOrReconnect);

  // ホストによるプレイヤーキック機能
  socket.on('kick_player', (payload) => {
    const room = getRoom(socket.roomId);
    if (!room) return;

    ensureValidHost(room);
    const isHost = (socket.playerToken === room.hostToken || socket.id === room.hostId);
    if (!isHost) {
      return socket.emit('error_message', 'キック権限がありません（部屋のホストのみキック可能です）');
    }

    const targetToken = payload && payload.targetToken;
    const targetId = payload && payload.targetId;

    const targetPlayer = room.players.find(p => (targetToken && p.token === targetToken) || (targetId && p.id === targetId));
    if (!targetPlayer) {
      return socket.emit('error_message', 'キック対象のプレイヤーが見つかりませんでした');
    }

    if (targetPlayer.token === room.hostToken) {
      return socket.emit('error_message', 'ホスト自身をキックすることはできません');
    }

    const kickedName = targetPlayer.name;
    const kickedToken = targetPlayer.token;
    const kickedSocketId = targetPlayer.id;

    // 対象のソケットへキック通知を送信
    const targetSocket = io.sockets.sockets.get(kickedSocketId);
    if (targetSocket) {
      targetSocket.emit('kicked', {
        roomId: room.roomId,
        message: `ホスト（${socket.playerName || '部屋主'}）によって部屋からキックされました。`
      });
      targetSocket.leave(room.roomId);
      delete targetSocket.roomId;
      delete targetSocket.playerToken;
    }

    const wasCurrentTurn = room.isGameStarted && room.players[room.currentTurnIndex]?.token === kickedToken;

    // プレイヤーリストから完全に削除
    room.players = room.players.filter(p => p.token !== kickedToken);
    room.logs.push(`👢 【${kickedName}】はホストによりキックされました`);

    // 保留アクションのクリーンアップ
    if (room.pendingDiscardPlayerId === kickedSocketId) room.pendingDiscardPlayerId = null;
    if (room.pendingSurvey && room.pendingSurvey.playerId === kickedSocketId) {
      room.decks.mineDeck.push(...room.pendingSurvey.candidates);
      room.decks.mineDeck = shuffle(room.decks.mineDeck);
      room.pendingSurvey = null;
    }
    if (room.pendingTrade && room.pendingTrade.playerId === kickedSocketId) room.pendingTrade = null;
    if (room.pendingReveal && room.pendingReveal.playerId === kickedSocketId) room.pendingReveal = null;

    if (room.isGameStarted) {
      if (room.players.length === 0) {
        room.isGameStarted = false;
        room.isGameOver = false;
      } else if (wasCurrentTurn) {
        if (room.currentTurnIndex >= room.players.length) {
          room.currentTurnIndex = 0;
        }
        broadcastState(room);
      } else {
        if (room.currentTurnIndex >= room.players.length) {
          room.currentTurnIndex = 0;
        }
        broadcastState(room);
      }
    } else {
      broadcastState(room);
    }

    io.to(room.roomId).emit('lobby_status', getLobbyStatus(room));
  });

  socket.on('skip_offline_turn', () => {
    const room = getRoom(socket.roomId);
    if (!room || !room.isGameStarted || room.isGameOver) return;

    const currentTurnPlayer = room.players[room.currentTurnIndex];
    if (!currentTurnPlayer || currentTurnPlayer.isOnline !== false) {
      return socket.emit('error_message', '現在の手番プレイヤーはオンラインです');
    }

    // 保留アクションを安全に解除
    if (room.pendingSurvey && room.pendingSurvey.playerId === currentTurnPlayer.id) {
      room.decks.mineDeck.push(...room.pendingSurvey.candidates);
      room.decks.mineDeck = shuffle(room.decks.mineDeck);
      room.pendingSurvey = null;
    }
    if (room.pendingDiscardPlayerId === currentTurnPlayer.id) {
      if (currentTurnPlayer.eventCards.length > 4) {
        const discarded = currentTurnPlayer.eventCards.pop();
        if (room.decks.eventDeck) room.decks.eventDeck.unshift(discarded);
      }
      room.pendingDiscardPlayerId = null;
    }
    if (room.pendingTrade && room.pendingTrade.playerId === currentTurnPlayer.id) {
      room.pendingTrade = null;
    }
    if (room.pendingReveal && room.pendingReveal.playerId === currentTurnPlayer.id) {
      room.pendingReveal = null;
    }

    room.logs.push(`⏩ 切断中のため、${currentTurnPlayer.name} のターンをスキップしました`);
    nextTurn(room);
  });

  socket.on('leave_room', () => {
    const room = getRoom(socket.roomId);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.isOnline = false;
    player.disconnectedAt = Date.now();
    room.logs.push(`🚪 ${player.name} が一時退席しました（いつでも復帰可能）`);
    socket.emit('left_room_confirm');

    // ホスト権限の再割当
    ensureValidHost(room);

    broadcastState(room);
    io.to(room.roomId).emit('lobby_status', getLobbyStatus(room));
  });

  socket.on('start_game', () => {
    const room = getRoom(socket.roomId);
    if (!room) return;

    if (room.players.length < 1) {
      return socket.emit('error_message', 'プレイヤーが足りません');
    }

    // ホスト権限チェック
    const isHost = (socket.playerToken === room.hostToken || socket.id === room.hostId);
    if (!isHost) {
      return socket.emit('error_message', 'ゲームを開始できるのはホストのみです');
    }

    // 始める順番（手番順）をランダムにシャッフル
    room.players = shuffle(room.players);
    room.decks = initializeDecks();
    room.discardActionDeck = [];
    room.isGameStarted = true;
    room.isGameOver = false;
    room.pendingDiscardPlayerId = null;
    room.pendingSurvey = null;
    room.pendingTrade = null;
    room.pendingReveal = null;
    room.currentTurnIndex = 0;
    room.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });

    const orderText = room.players.map((p, idx) => `${idx + 1}番手: ${p.name}`).join('、');
    room.logs.push(`🎲 手番順をランダムに決定しました（${orderText}）`);
    room.logs.push(`ゲームを開始しました！最初のプレイヤーは【${room.players[0].name}】さんです。`);
    broadcastState(room);
  });

  // 再戦・ロビーへ戻る
  socket.on('restart_game', () => {
    const room = getRoom(socket.roomId);
    if (!room) return;

    room.isGameStarted = false;
    room.isGameOver = false;
    room.pendingDiscardPlayerId = null;
    room.pendingSurvey = null;
    room.pendingTrade = null;
    room.pendingReveal = null;
    room.currentTurnIndex = 0;
    room.decks = { actionDeck: [], mineDeck: [], eventDeck: [] };
    room.discardActionDeck = [];
    room.players.forEach(p => { p.scoreCards = []; p.eventCards = []; });
    room.logs.push('ゲームがリセットされました。再戦待機中です。');
    broadcastState(room, { gameOver: false });
  });

  // 行動山札を引く
  socket.on('draw_action_deck', () => {
    const room = getRoom(socket.roomId);
    if (!room) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (room.pendingDiscardPlayerId === socket.id) return;
    if (room.pendingSurvey || room.pendingTrade || room.pendingReveal) return;

    if (room.decks.actionDeck.length === 0) {
      room.decks.actionDeck = shuffle(room.discardActionDeck);
      room.discardActionDeck = [];
      room.logs.push('行動山札をリシャッフルしました');
    }

    const drawn = room.decks.actionDeck.pop();
    room.discardActionDeck.push(drawn);

    if (drawn === 'つるはし') {
      const drawnCards = drawFromMine(room, currentPlayer, 1);
      let evTextPrivate = '';
      let evTextPublic = '';
      if (room.decks.eventDeck.length > 0) {
        const evCard = room.decks.eventDeck.pop();
        const withinLimit = addEventCardToPlayer(room, currentPlayer, evCard);
        if (withinLimit) {
          evTextPrivate = ' ＆ イベント1枚';
          evTextPublic = ' ＆ イベント1枚(非公開)';
        } else {
          evTextPrivate = ' ＆ イベント1枚(※手札上限超過・捨てるカードを選択中)';
          evTextPublic = ' ＆ イベント1枚(※手札上限超過・捨てるカードを選択中)';
        }
      } else {
        evTextPrivate = '（※イベント山札空）';
        evTextPublic = '（※イベント山札空）';
      }
      const cardsText = drawnCards.map(c => c.type === 'bomb' ? '💥爆弾' : `${c.name}(${c.value}点)`).join('・') || '0枚';
      room.logs.push({
        playerId: currentPlayer.id,
        privateText: `⛏️ あなた は【つるはし】で【${cardsText}】を採掘！${evTextPrivate}`,
        publicText: `⛏️ ${currentPlayer.name} は【つるはし】で鉱山${drawnCards.length}枚獲得！${evTextPublic}`
      });
    } else if (drawn === 'ドリル') {
      const drawnCards = drawFromMine(room, currentPlayer, 2);
      const cardsText = drawnCards.map(c => c.type === 'bomb' ? '💥爆弾' : `${c.name}(${c.value}点)`).join('・') || '0枚';
      room.logs.push({
        playerId: currentPlayer.id,
        privateText: `⚡ あなた は【ドリル】で【${cardsText}】を採掘！`,
        publicText: `⚡ ${currentPlayer.name} は【ドリル】で鉱山から${drawnCards.length}枚採掘`
      });
    }

    // 鉱山切れ・鉱石枯渇チェック
    if (checkMineDepletion(room)) {
      return;
    }

    // 捨てるカード選択中の場合はターンを進めずに待機
    if (room.pendingDiscardPlayerId === currentPlayer.id) {
      broadcastState(room);
      return;
    }

    nextTurn(room);
  });

  // 手札上限超過時のイベントカード破棄（山札の底に戻す）
  socket.on('discard_event', (payload) => {
    const room = getRoom(socket.roomId);
    if (!room) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (room.pendingDiscardPlayerId !== socket.id) return;

    const cardIndex = (typeof payload === 'object' && payload !== null) ? payload.cardIndex : payload;
    if (typeof cardIndex !== 'number' || cardIndex < 0 || cardIndex >= currentPlayer.eventCards.length) return;

    const discarded = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    room.decks.eventDeck.unshift(discarded);
    room.logs.push(`🗑️ ${currentPlayer.name} はイベント【${discarded.name}】を選んで山札に戻しました`);

    if (currentPlayer.eventCards.length <= 4) {
      room.pendingDiscardPlayerId = null;

      // 鉱山切れ・鉱石枯渇チェック
      if (checkMineDepletion(room)) {
        return;
      }
      nextTurn(room);
    } else {
      broadcastState(room);
    }
  });

  // イベントカード使用
  socket.on('use_event', (payload) => {
    const room = getRoom(socket.roomId);
    if (!room) return;

    const currentPlayer = room.players[room.currentTurnIndex];
    if (!currentPlayer || currentPlayer.id !== socket.id) return;
    if (room.pendingDiscardPlayerId === socket.id) return;
    if (room.pendingSurvey || room.pendingTrade || room.pendingReveal) return;

    const cardIndex = (typeof payload === 'object' && payload !== null) ? payload.cardIndex : payload;
    const selectedScoreCardIndex = (typeof payload === 'object' && payload !== null) ? payload.selectedScoreCardIndex : null;
    const targetPlayerId = (typeof payload === 'object' && payload !== null) ? payload.targetPlayerId : null;

    if (!currentPlayer.eventCards[cardIndex]) return;

    const usedCard = currentPlayer.eventCards.splice(cardIndex, 1)[0];
    room.logs.push(`${currentPlayer.name} はイベント【${usedCard.name}】を使用しました`);

    // 部屋全員にイベントカード使用・中央表示演出を通知
    io.to(room.roomId).emit('event_card_played', {
      playerId: currentPlayer.id,
      playerName: currentPlayer.name,
      card: { id: usedCard.id, name: usedCard.name }
    });

    // 使用後はイベント山札の一番下に戻す
    room.decks.eventDeck.unshift(usedCard);

    // イベント効果分岐
    if (usedCard.id === 'blast') {
      // 爆破：爆弾カードを持つプレイヤーは爆弾を鉱山に戻し、得点カードをランダムに3枚破壊
      const bombPlayers = room.players.filter(p => p.scoreCards.some(c => c.type === 'bomb'));
      if (bombPlayers.length > 0) {
        bombPlayers.forEach(bombPlayer => {
          // 爆弾を取り除いて鉱山に戻す
          const bIdx = bombPlayer.scoreCards.findIndex(c => c.type === 'bomb');
          const bombCard = bombPlayer.scoreCards.splice(bIdx, 1)[0];
          room.decks.mineDeck.push(bombCard);

          // 非爆弾の得点カードを抽出
          let scoreCards = bombPlayer.scoreCards.filter(c => c.type !== 'bomb');
          let bombCards = bombPlayer.scoreCards.filter(c => c.type === 'bomb');

          // シャッフルしてランダムに最大3枚破壊
          scoreCards = shuffle(scoreCards);
          const destroyedCards = scoreCards.slice(0, 3);
          const remainingScoreCards = scoreCards.slice(3);

          bombPlayer.scoreCards = [...remainingScoreCards, ...bombCards];

          if (destroyedCards.length > 0) {
            const destroyedText = destroyedCards.map(c => `【${c.name} (${c.value}点)】`).join(' ＆ ');
            const totalLost = destroyedCards.reduce((sum, c) => sum + (c.value || 0), 0);
            room.logs.push(`💣【爆破】発動！ ${bombPlayer.name} の爆弾が爆発し、得点カード ${destroyedText} をランダムに3枚破壊！ (-${totalLost}点)`);
          } else {
            room.logs.push(`💣【爆破】発動！ ${bombPlayer.name} の爆弾が爆発！（破壊できる得点カードなし）`);
          }
        });

        // 鉱山山札をシャッフル
        room.decks.mineDeck = shuffle(room.decks.mineDeck);
      } else {
        room.logs.push('💣 誰も爆弾を持っていなかったため【爆破】は不発でした');
      }
    } else if (usedCard.id === 'share') {
      // 山分け：全プレイヤーが得点を持っていれば実行
      const allHave = room.players.every(p => p.scoreCards.length > 0);
      if (allHave) {
        let allScores = [];
        room.players.forEach(p => {
          allScores.push(...p.scoreCards);
          p.scoreCards = [];
        });
        allScores = shuffle(allScores);

        // 使用者の左隣（次の人）から順に時計回り配り、自分が最後になるように配る
        let pIdx = (room.currentTurnIndex + 1) % room.players.length;
        while (allScores.length > 0) {
          room.players[pIdx].scoreCards.push(allScores.pop());
          pIdx = (pIdx + 1) % room.players.length;
        }
        room.logs.push('🤝 得点カードが回収され、全員に均等に山分けされました！');
      } else {
        room.logs.push('🤝 全員が得点を持っていないため山分けは不発でした');
      }
    } else if (usedCard.id === 'reveal') {
      // 公開：相手プレイヤーの手札得点を全員に公開
      const otherPlayers = room.players.filter(p => p.id !== currentPlayer.id);
      if (otherPlayers.length === 0) {
        room.logs.push('👁️ 他に対象プレイヤーがいませんでした');
        nextTurn(room);
        return;
      }

      let target = (typeof targetPlayerId === 'string')
        ? otherPlayers.find(p => p.id === targetPlayerId)
        : null;

      if (target) {
        // 相手が選択済みなら即時公開を実行
        const counts = { '石炭': 0, '金': 0, 'ダイヤ': 0, '爆弾': 0 };
        let totalPts = 0;
        target.scoreCards.forEach(c => {
          if (c.type === 'bomb') {
            counts['爆弾']++;
          } else {
            if (counts[c.name] === undefined) counts[c.name] = 0;
            counts[c.name]++;
            totalPts += (c.value || 0);
          }
        });

        const parts = [];
        if (counts['石炭'] > 0) parts.push(`石炭${counts['石炭']}枚`);
        if (counts['金'] > 0) parts.push(`金${counts['金']}枚`);
        if (counts['ダイヤ'] > 0) parts.push(`ダイヤ${counts['ダイヤ']}枚`);
        if (counts['爆弾'] > 0) parts.push(`💥爆弾${counts['爆弾']}枚`);

        const summary = parts.length > 0 ? parts.join('、') + ` (計${totalPts}点 / 全${target.scoreCards.length}枚)` : 'カードなし (0点)';
        room.logs.push(`👁️【公開】${currentPlayer.name} は ${target.name} を指名！ ➔ 手札: ${summary}`);
        nextTurn(room);
        return;
      }

      // 未指定の場合は選択待機ダイアログを送信
      room.pendingReveal = {
        playerId: currentPlayer.id
      };
      socket.emit('reveal_select_dialog');
      broadcastState(room);
      return;
    } else if (usedCard.id === 'rob') {
      // 強奪：一番多く得点を持っている他プレイヤーからランダム1枚奪う
      let maxCount = -1;
      let targets = [];
      room.players.forEach(p => {
        if (p.id !== currentPlayer.id) {
          if (p.scoreCards.length > maxCount) {
            maxCount = p.scoreCards.length;
            targets = [p];
          } else if (p.scoreCards.length === maxCount) {
            targets.push(p);
          }
        }
      });
      if (targets.length > 0 && maxCount > 0) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        const robIdx = Math.floor(Math.random() * target.scoreCards.length);
        const robbed = target.scoreCards.splice(robIdx, 1)[0];
        currentPlayer.scoreCards.push(robbed);
        room.logs.push(`🦹 ${currentPlayer.name} は ${target.name} から得点を1枚奪いました！`);
      } else {
        room.logs.push('🦹 他プレイヤーに奪える得点がありませんでした');
      }
    } else if (usedCard.id === 'trade') {
      // 取引：相手プレイヤーと自分の得点カードを交換
      const otherPlayersWithCards = room.players.filter(p => p.id !== currentPlayer.id && p.scoreCards.length > 0);
      if (currentPlayer.scoreCards.length === 0 || otherPlayersWithCards.length === 0) {
        room.logs.push('🔄 交換できるカードまたは対象プレイヤーが不足しているため取引は不発でした');
        nextTurn(room);
        return;
      }

      let partner = (typeof targetPlayerId === 'string')
        ? otherPlayersWithCards.find(p => p.id === targetPlayerId)
        : null;

      let validCardIdx = (typeof selectedScoreCardIndex === 'number' && selectedScoreCardIndex >= 0 && selectedScoreCardIndex < currentPlayer.scoreCards.length)
        ? selectedScoreCardIndex
        : null;

      if (partner && validCardIdx !== null) {
        // 相手と渡すカードが選択済みなら即時取引を実行
        const partnerCardIdx = Math.floor(Math.random() * partner.scoreCards.length);
        const myCard = currentPlayer.scoreCards.splice(validCardIdx, 1)[0];
        const partnerCard = partner.scoreCards.splice(partnerCardIdx, 1)[0];

        currentPlayer.scoreCards.push(partnerCard);
        partner.scoreCards.push(myCard);

        const myCardText = myCard.type === 'bomb' ? '💥爆弾' : `${myCard.name}(${myCard.value}点)`;
        room.logs.push(`🔄 ${currentPlayer.name} は【${myCardText}】を渡し、${partner.name} と得点カードを取引しました！`);
        nextTurn(room);
        return;
      }

      // 未指定の場合は選択待機ダイアログを送信
      room.pendingTrade = {
        playerId: currentPlayer.id
      };
      socket.emit('trade_select_dialog');
      broadcastState(room);
      return;
    } else if (usedCard.id === 'bribe') {
      // 賄賂：自分の得点の一番小さいカードを鉱山に戻し、イベント山札から2枚引く
      let minVal = Infinity;
      let minIdx = -1;
      currentPlayer.scoreCards.forEach((c, idx) => {
        if (c.type === 'score' && typeof c.value === 'number' && c.value < minVal) {
          minVal = c.value;
          minIdx = idx;
        }
      });

      if (minIdx !== -1) {
        const returnedCard = currentPlayer.scoreCards.splice(minIdx, 1)[0];
        room.decks.mineDeck.push(returnedCard);
        room.decks.mineDeck = shuffle(room.decks.mineDeck);

        let drawnCount = 0;
        for (let i = 0; i < 2; i++) {
          if (room.decks.eventDeck.length > 0) {
            const evCard = room.decks.eventDeck.pop();
            addEventCardToPlayer(room, currentPlayer, evCard);
            drawnCount++;
          }
        }
        let bribeMsg = `💰 ${currentPlayer.name} は【賄賂】を使い、【${returnedCard.name} (${returnedCard.value}点)】を鉱山に戻してイベントカードを${drawnCount}枚獲得しました！`;
        if (currentPlayer.eventCards.length > 4) {
          bribeMsg += `（※手札上限4枚を超えたため、捨てるカードを選択中）`;
        }
        room.logs.push(bribeMsg);
      } else {
        room.logs.push(`${currentPlayer.name} は賄賂を使おうとしましたが、戻せる得点カードが無いため不発となりました`);
      }
    } else if (usedCard.id === 'survey') {
      // 調査：鉱山から5枚見て、その中から1枚選ぶ（他プレイヤーには非公開）
      if (room.decks.mineDeck.length === 0) {
        room.logs.push('🔍 鉱山山札が空のため調査できませんでした');
        nextTurn(room);
        return;
      }

      const count = Math.min(5, room.decks.mineDeck.length);
      const candidates = [];
      for (let i = 0; i < count; i++) {
        candidates.push(room.decks.mineDeck.pop());
      }

      room.pendingSurvey = {
        playerId: currentPlayer.id,
        candidates: candidates
      };

      // 調査者本人にのみ候補カードを送信（他プレイヤーには完全非公開）
      socket.emit('survey_pick_card', {
        candidates: candidates.map((c, idx) => ({
          idx,
          type: c.type,
          name: c.name,
          value: c.value
        }))
      });

      // 他プレイヤー向けのログ
      room.logs.push(`🔍 ${currentPlayer.name} は【調査】を使用しました`);

      broadcastState(room);
      return;
    }

    if (room.pendingDiscardPlayerId === currentPlayer.id) {
      broadcastState(room);
      return;
    }

    nextTurn(room);
  });

  // 調査イベントのカード選択
  socket.on('choose_survey_card', (payload) => {
    const room = getRoom(socket.roomId);
    if (!room || !room.pendingSurvey || room.pendingSurvey.playerId !== socket.id) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    const candidates = room.pendingSurvey.candidates;
    let selectedIdx = (payload && typeof payload.selectedIndex === 'number') ? payload.selectedIndex : 0;
    if (selectedIdx < 0 || selectedIdx >= candidates.length) selectedIdx = 0;

    // 選んだカードを手札に追加
    const chosenCard = candidates[selectedIdx];
    player.scoreCards.push(chosenCard);

    // 選ばれなかった残りのカードを鉱山山札に戻してシャッフル
    const remaining = candidates.filter((_, idx) => idx !== selectedIdx);
    room.decks.mineDeck.push(...remaining);
    room.decks.mineDeck = shuffle(room.decks.mineDeck);

    room.pendingSurvey = null;

    // ログ
    const chosenText = chosenCard.type === 'bomb' ? '💥爆弾' : `${chosenCard.name}(${chosenCard.value}点)`;
    room.logs.push({
      playerId: player.id,
      privateText: `🔍 あなた は【調査】で【${chosenText}】を獲得しました！`,
      publicText: `🔍 ${player.name} は【調査】で鉱山から1枚選んで獲得しました`
    });

    // 鉱山切れ・鉱石枯渇チェック
    if (checkMineDepletion(room)) {
      return;
    }

    nextTurn(room);
  });

  // 取引イベントの選択確定
  socket.on('choose_trade_options', (payload) => {
    const room = getRoom(socket.roomId);
    if (!room || !room.pendingTrade || room.pendingTrade.playerId !== socket.id) return;

    const currentPlayer = room.players.find(p => p.id === socket.id);
    if (!currentPlayer) return;

    const otherPlayersWithCards = room.players.filter(p => p.id !== currentPlayer.id && p.scoreCards.length > 0);
    let partner = null;
    const targetPlayerId = payload ? payload.targetPlayerId : null;
    if (typeof targetPlayerId === 'string') {
      partner = otherPlayersWithCards.find(p => p.id === targetPlayerId);
    }
    if (!partner && otherPlayersWithCards.length > 0) {
      partner = otherPlayersWithCards[0];
    }

    if (currentPlayer.scoreCards.length > 0 && partner && partner.scoreCards.length > 0) {
      let myCardIdx = 0;
      const selectedScoreCardIndex = payload ? payload.selectedScoreCardIndex : 0;
      if (typeof selectedScoreCardIndex === 'number' && selectedScoreCardIndex >= 0 && selectedScoreCardIndex < currentPlayer.scoreCards.length) {
        myCardIdx = selectedScoreCardIndex;
      }

      const partnerCardIdx = Math.floor(Math.random() * partner.scoreCards.length);

      const myCard = currentPlayer.scoreCards.splice(myCardIdx, 1)[0];
      const partnerCard = partner.scoreCards.splice(partnerCardIdx, 1)[0];

      currentPlayer.scoreCards.push(partnerCard);
      partner.scoreCards.push(myCard);

      const myCardText = myCard.type === 'bomb' ? '💥爆弾' : `${myCard.name}(${myCard.value}点)`;
      room.logs.push(`🔄 ${currentPlayer.name} は【${myCardText}】を渡し、${partner.name} と得点カードを取引しました！`);
    } else {
      room.logs.push('🔄 交換できるカードまたは対象プレイヤーが不足しているため取引は不発でした');
    }

    room.pendingTrade = null;
    nextTurn(room);
  });

  // 公開イベントの対象確定
  socket.on('choose_reveal_target', (payload) => {
    const room = getRoom(socket.roomId);
    if (!room || !room.pendingReveal || room.pendingReveal.playerId !== socket.id) return;

    const currentPlayer = room.players.find(p => p.id === socket.id);
    if (!currentPlayer) return;

    const otherPlayers = room.players.filter(p => p.id !== currentPlayer.id);
    let target = null;
    const targetPlayerId = payload ? payload.targetPlayerId : null;
    if (typeof targetPlayerId === 'string') {
      target = otherPlayers.find(p => p.id === targetPlayerId);
    }
    if (!target && otherPlayers.length > 0) {
      target = otherPlayers[0];
    }

    if (target) {
      const counts = { '石炭': 0, '金': 0, 'ダイヤ': 0, '爆弾': 0 };
      let totalPts = 0;
      target.scoreCards.forEach(c => {
        if (c.type === 'bomb') {
          counts['爆弾']++;
        } else {
          if (counts[c.name] === undefined) counts[c.name] = 0;
          counts[c.name]++;
          totalPts += (c.value || 0);
        }
      });

      const parts = [];
      if (counts['石炭'] > 0) parts.push(`石炭${counts['石炭']}枚`);
      if (counts['金'] > 0) parts.push(`金${counts['金']}枚`);
      if (counts['ダイヤ'] > 0) parts.push(`ダイヤ${counts['ダイヤ']}枚`);
      if (counts['爆弾'] > 0) parts.push(`💥爆弾${counts['爆弾']}枚`);

      const summary = parts.length > 0 ? parts.join('、') + ` (計${totalPts}点 / 全${target.scoreCards.length}枚)` : 'カードなし (0点)';
      room.logs.push(`👁️【公開】${currentPlayer.name} は ${target.name} を指名！ ➔ 手札: ${summary}`);
    } else {
      room.logs.push('👁️ 他に対象プレイヤーがいませんでした');
    }

    room.pendingReveal = null;
    nextTurn(room);
  });

  socket.on('disconnect', () => {
    // どの部屋に所属しているかを特定
    let room = getRoom(socket.roomId);
    let leftPlayer = null;

    if (room) {
      leftPlayer = room.players.find(p => p.id === socket.id);
    } else {
      for (const r of rooms.values()) {
        const found = r.players.find(p => p.id === socket.id);
        if (found) {
          room = r;
          leftPlayer = found;
          break;
        }
      }
    }

    if (!room || !leftPlayer) return;

    leftPlayer.isOnline = false;
    leftPlayer.disconnectedAt = Date.now();

    // ホストの再割当確認
    ensureValidHost(room);

    if (room.isGameStarted) {
      // ゲーム中の場合はプレイヤー情報（得点カード、イベントカード、ターン）を保持
      room.logs.push(`⚠️ ${leftPlayer.name} の通信が切断されました（同じ名前または端末で再入室可能）`);
      broadcastState(room);
      io.to(room.roomId).emit('lobby_status', getLobbyStatus(room));
    } else {
      // ロビー待機中の場合: 25秒戻らなければロビーから除外
      setTimeout(() => {
        if (!room.isGameStarted && !leftPlayer.isOnline) {
          room.players = room.players.filter(p => p.token !== leftPlayer.token);
          room.logs.push(`${leftPlayer.name} が退出しました`);
          ensureValidHost(room);
          broadcastState(room);
          io.to(room.roomId).emit('lobby_status', getLobbyStatus(room));
        }
      }, 25000);
      broadcastState(room);
      io.to(room.roomId).emit('lobby_status', getLobbyStatus(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`炭鉱夫サーバー起動完了: http://0.0.0.0:${PORT}`);
});
