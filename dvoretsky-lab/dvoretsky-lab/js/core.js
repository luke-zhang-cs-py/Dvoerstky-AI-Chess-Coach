/* core.js — chess rules engine (0x88). No dependencies.
   Exposes window.Chess (browser) and module.exports (node). */
(function (root) {
  'use strict';

  var EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
  var WHITE = 8, BLACK = 16, COLOR_MASK = 24, TYPE_MASK = 7;

  var SYM = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
  var FROM_SYM = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

  // offsets
  var KNIGHT_OFF = [-33, -31, -18, -14, 14, 18, 31, 33];
  var BISHOP_OFF = [-17, -15, 15, 17];
  var ROOK_OFF = [-16, -1, 1, 16];
  var KING_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];

  var FLAG = { NORMAL: 1, CAPTURE: 2, BIG_PAWN: 4, EP: 8, PROMO: 16, KSIDE: 32, QSIDE: 64 };

  function file(sq) { return sq & 15; }
  function rank(sq) { return sq >> 4; }
  function algebraic(sq) { return 'abcdefgh'[file(sq)] + (8 - rank(sq)); }
  function sq0x88(name) {
    var f = 'abcdefgh'.indexOf(name[0]);
    var r = 8 - parseInt(name[1], 10);
    return r * 16 + f;
  }

  function Chess(fen) {
    this.board = new Int8Array(128);
    this.kings = { 8: -1, 16: -1 };
    this.turn = WHITE;
    this.castling = { 8: 0, 16: 0 };
    this.ep = -1;
    this.halfmoves = 0;
    this.movenumber = 1;
    this.history = [];
    this.load(fen || Chess.START);
  }
  Chess.START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  Chess.prototype.clear = function () {
    this.board = new Int8Array(128);
    this.kings = { 8: -1, 16: -1 };
    this.turn = WHITE; this.castling = { 8: 0, 16: 0 };
    this.ep = -1; this.halfmoves = 0; this.movenumber = 1; this.history = [];
  };

  Chess.prototype.load = function (fen) {
    this.clear();
    var parts = fen.trim().split(/\s+/);
    var rows = parts[0].split('/');
    var sq = 0;
    for (var r = 0; r < 8; r++) {
      var row = rows[r]; sq = r * 16;
      for (var i = 0; i < row.length; i++) {
        var c = row[i];
        if (/[1-8]/.test(c)) { sq += parseInt(c, 10); }
        else {
          var color = c === c.toUpperCase() ? WHITE : BLACK;
          var type = FROM_SYM[c.toLowerCase()];
          this.board[sq] = type | color;
          if (type === KING) this.kings[color] = sq;
          sq++;
        }
      }
    }
    this.turn = parts[1] === 'w' ? WHITE : BLACK;
    var cst = parts[2] || '-';
    if (cst.indexOf('K') > -1) this.castling[WHITE] |= FLAG.KSIDE;
    if (cst.indexOf('Q') > -1) this.castling[WHITE] |= FLAG.QSIDE;
    if (cst.indexOf('k') > -1) this.castling[BLACK] |= FLAG.KSIDE;
    if (cst.indexOf('q') > -1) this.castling[BLACK] |= FLAG.QSIDE;
    this.ep = (!parts[3] || parts[3] === '-') ? -1 : sq0x88(parts[3]);
    this.halfmoves = parseInt(parts[4], 10) || 0;
    this.movenumber = parseInt(parts[5], 10) || 1;
    return this;
  };

  Chess.prototype.fen = function () {
    var out = '', empty = 0;
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var p = this.board[r * 16 + f];
        if (!p) empty++;
        else {
          if (empty) { out += empty; empty = 0; }
          var s = SYM[p & TYPE_MASK];
          out += (p & COLOR_MASK) === WHITE ? s.toUpperCase() : s;
        }
      }
      if (empty) { out += empty; empty = 0; }
      if (r < 7) out += '/';
    }
    var cst = '';
    if (this.castling[WHITE] & FLAG.KSIDE) cst += 'K';
    if (this.castling[WHITE] & FLAG.QSIDE) cst += 'Q';
    if (this.castling[BLACK] & FLAG.KSIDE) cst += 'k';
    if (this.castling[BLACK] & FLAG.QSIDE) cst += 'q';
    return out + ' ' + (this.turn === WHITE ? 'w' : 'b') + ' ' + (cst || '-') + ' ' +
      (this.ep === -1 ? '-' : algebraic(this.ep)) + ' ' + this.halfmoves + ' ' + this.movenumber;
  };

  // Scan outward FROM the target square — O(30) instead of O(board x rays).
  Chess.prototype.attacked = function (color, target) {
    var b = this.board, i, off, cur, p;
    // pawns: a pawn of `color` attacking `target` sits one rank "behind" target
    var pdir = color === WHITE ? 16 : -16; // where the attacker sits relative to target
    for (i = -1; i <= 1; i += 2) {
      cur = target + pdir + i;
      if (!(cur & 0x88) && b[cur] === (PAWN | color)) return true;
    }
    for (i = 0; i < 8; i++) {
      cur = target + KNIGHT_OFF[i];
      if (!(cur & 0x88) && b[cur] === (KNIGHT | color)) return true;
    }
    for (i = 0; i < 8; i++) {
      cur = target + KING_OFF[i];
      if (!(cur & 0x88) && b[cur] === (KING | color)) return true;
    }
    for (i = 0; i < 4; i++) {
      off = ROOK_OFF[i]; cur = target + off;
      while (!(cur & 0x88)) {
        p = b[cur];
        if (p) {
          if ((p & COLOR_MASK) === color) { var t = p & TYPE_MASK; if (t === ROOK || t === QUEEN) return true; }
          break;
        }
        cur += off;
      }
    }
    for (i = 0; i < 4; i++) {
      off = BISHOP_OFF[i]; cur = target + off;
      while (!(cur & 0x88)) {
        p = b[cur];
        if (p) {
          if ((p & COLOR_MASK) === color) { var t2 = p & TYPE_MASK; if (t2 === BISHOP || t2 === QUEEN) return true; }
          break;
        }
        cur += off;
      }
    }
    return false;
  };

  // Fast mobility counter: no object allocation.
  Chess.prototype.mobility = function (color) {
    var b = this.board, count = 0, sq, p, type, i, off, cur, offs, sliding;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      p = b[sq];
      if (!p || (p & COLOR_MASK) !== color) continue;
      type = p & TYPE_MASK;
      if (type === PAWN) continue;
      offs = type === KNIGHT ? KNIGHT_OFF : type === KING ? KING_OFF :
        type === BISHOP ? BISHOP_OFF : type === ROOK ? ROOK_OFF : KING_OFF;
      sliding = (type === BISHOP || type === ROOK || type === QUEEN);
      for (i = 0; i < offs.length; i++) {
        off = offs[i]; cur = sq;
        while (true) {
          cur += off;
          if (cur & 0x88) break;
          if (!b[cur]) { count++; if (!sliding) break; continue; }
          if ((b[cur] & COLOR_MASK) !== color) count++;
          break;
        }
      }
    }
    return count;
  };

  Chess.prototype.inCheck = function (color) {
    color = color || this.turn;
    var k = this.kings[color];
    if (k < 0) return false;
    return this.attacked(color === WHITE ? BLACK : WHITE, k);
  };

  function mk(board, from, to, flags, promo) {
    var m = { from: from, to: to, piece: board[from] & TYPE_MASK,
      color: board[from] & COLOR_MASK, flags: flags, promo: promo || 0,
      captured: 0, fromSq: algebraic(from), toSq: algebraic(to) };
    if (flags & FLAG.EP) m.captured = PAWN;
    else if (board[to]) m.captured = board[to] & TYPE_MASK;
    return m;
  }

  Chess.prototype.generate = function (opts) {
    opts = opts || {};
    var legalOnly = opts.legal !== false;
    var us = this.turn, them = us === WHITE ? BLACK : WHITE;
    var moves = [], b = this.board;
    var single = opts.square !== undefined ? sq0x88(opts.square) : -1;

    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (single >= 0 && sq !== single) continue;
      var p = b[sq];
      if (!p || (p & COLOR_MASK) !== us) continue;
      var type = p & TYPE_MASK, i, off, cur;

      if (type === PAWN) {
        var dir = us === WHITE ? -16 : 16;
        var startRank = us === WHITE ? 6 : 1;
        var promoRank = us === WHITE ? 0 : 7;
        var one = sq + dir;
        if (!(one & 0x88) && !b[one]) {
          if (rank(one) === promoRank) {
            [QUEEN, ROOK, BISHOP, KNIGHT].forEach(function (pc) { moves.push(mk(b, sq, one, FLAG.PROMO, pc)); });
          } else {
            moves.push(mk(b, sq, one, FLAG.NORMAL));
            var two = sq + dir * 2;
            if (rank(sq) === startRank && !b[two]) moves.push(mk(b, sq, two, FLAG.BIG_PAWN));
          }
        }
        for (i = -1; i <= 1; i += 2) {
          var cap = sq + dir + i;
          if (cap & 0x88) continue;
          if (b[cap] && (b[cap] & COLOR_MASK) === them) {
            if (rank(cap) === promoRank) {
              [QUEEN, ROOK, BISHOP, KNIGHT].forEach(function (pc) { moves.push(mk(b, sq, cap, FLAG.PROMO | FLAG.CAPTURE, pc)); });
            } else moves.push(mk(b, sq, cap, FLAG.CAPTURE));
          } else if (cap === this.ep) {
            moves.push(mk(b, sq, cap, FLAG.EP | FLAG.CAPTURE));
          }
        }
        continue;
      }

      var offs = type === KNIGHT ? KNIGHT_OFF : type === KING ? KING_OFF :
        type === BISHOP ? BISHOP_OFF : type === ROOK ? ROOK_OFF : BISHOP_OFF.concat(ROOK_OFF);
      var sliding = (type === BISHOP || type === ROOK || type === QUEEN);
      for (i = 0; i < offs.length; i++) {
        off = offs[i]; cur = sq;
        while (true) {
          cur += off;
          if (cur & 0x88) break;
          if (!b[cur]) moves.push(mk(b, sq, cur, FLAG.NORMAL));
          else {
            if ((b[cur] & COLOR_MASK) === them) moves.push(mk(b, sq, cur, FLAG.CAPTURE));
            break;
          }
          if (!sliding) break;
        }
      }
    }

    // castling
    if (single < 0 || single === this.kings[us]) {
      var k = this.kings[us];
      if (k >= 0 && !this.attacked(them, k)) {
        if (this.castling[us] & FLAG.KSIDE) {
          if (!b[k + 1] && !b[k + 2] && (b[k + 3] & TYPE_MASK) === ROOK &&
              !this.attacked(them, k + 1) && !this.attacked(them, k + 2)) {
            moves.push(mk(b, k, k + 2, FLAG.KSIDE));
          }
        }
        if (this.castling[us] & FLAG.QSIDE) {
          if (!b[k - 1] && !b[k - 2] && !b[k - 3] && (b[k - 4] & TYPE_MASK) === ROOK &&
              !this.attacked(them, k - 1) && !this.attacked(them, k - 2)) {
            moves.push(mk(b, k, k - 2, FLAG.QSIDE));
          }
        }
      }
    }

    if (!legalOnly) return moves;
    var legal = [];
    for (var j = 0; j < moves.length; j++) {
      this.makeMove(moves[j]);
      if (!this.attacked(this.turn, this.kings[us])) legal.push(moves[j]);
      this.undoMove();
    }
    return legal;
  };

  Chess.prototype.moves = function (opts) {
    var ms = this.generate(opts);
    if (opts && opts.verbose) { var self = this; ms.forEach(function (m) { m.san = self.san(m); }); }
    return ms;
  };

  Chess.prototype.makeMove = function (m) {
    var us = this.turn, them = us === WHITE ? BLACK : WHITE, b = this.board;
    this.history.push({
      move: m, kings: { 8: this.kings[8], 16: this.kings[16] },
      turn: this.turn, castling: { 8: this.castling[8], 16: this.castling[16] },
      ep: this.ep, half: this.halfmoves, num: this.movenumber
    });
    b[m.to] = b[m.from];
    b[m.from] = EMPTY;
    if (m.flags & FLAG.EP) b[m.to + (us === WHITE ? 16 : -16)] = EMPTY;
    if (m.flags & FLAG.PROMO) b[m.to] = m.promo | us;
    if ((b[m.to] & TYPE_MASK) === KING) {
      this.kings[us] = m.to;
      if (m.flags & FLAG.KSIDE) { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = EMPTY; }
      if (m.flags & FLAG.QSIDE) { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = EMPTY; }
      this.castling[us] = 0;
    }
    // rook moves / captures kill castling rights
    var wk = us === WHITE ? 116 : 4; // e1 / e8 index not needed; use rook home squares
    if (this.castling[us]) {
      if (m.from === (us === WHITE ? 119 : 7)) this.castling[us] &= ~FLAG.KSIDE;
      if (m.from === (us === WHITE ? 112 : 0)) this.castling[us] &= ~FLAG.QSIDE;
    }
    if (this.castling[them]) {
      if (m.to === (them === WHITE ? 119 : 7)) this.castling[them] &= ~FLAG.KSIDE;
      if (m.to === (them === WHITE ? 112 : 0)) this.castling[them] &= ~FLAG.QSIDE;
    }
    this.ep = (m.flags & FLAG.BIG_PAWN) ? (us === WHITE ? m.to + 16 : m.to - 16) : -1;
    if (m.piece === PAWN || (m.flags & (FLAG.CAPTURE | FLAG.EP))) this.halfmoves = 0;
    else this.halfmoves++;
    if (us === BLACK) this.movenumber++;
    this.turn = them;
    void wk;
    return m;
  };

  Chess.prototype.undoMove = function () {
    var h = this.history.pop();
    if (!h) return null;
    var m = h.move, b = this.board;
    this.kings[8] = h.kings[8]; this.kings[16] = h.kings[16];
    this.turn = h.turn; this.castling[8] = h.castling[8]; this.castling[16] = h.castling[16];
    this.ep = h.ep; this.halfmoves = h.half; this.movenumber = h.num;
    var us = h.turn, them = us === WHITE ? BLACK : WHITE;
    b[m.from] = (m.flags & FLAG.PROMO) ? (PAWN | us) : b[m.to];
    b[m.to] = EMPTY;
    if (m.flags & FLAG.EP) {
      b[m.to + (us === WHITE ? 16 : -16)] = PAWN | them;
    } else if (m.captured) {
      b[m.to] = m.captured | them;
    }
    if (m.flags & FLAG.KSIDE) { b[m.to + 1] = b[m.to - 1]; b[m.to - 1] = EMPTY; }
    if (m.flags & FLAG.QSIDE) { b[m.to - 2] = b[m.to + 1]; b[m.to + 1] = EMPTY; }
    return m;
  };

  Chess.prototype.san = function (move, precomputed) {
    var out = '';
    if (move.flags & FLAG.KSIDE) out = 'O-O';
    else if (move.flags & FLAG.QSIDE) out = 'O-O-O';
    else {
      if (move.piece !== PAWN) {
        out += SYM[move.piece].toUpperCase();
        // disambiguation
        var others = precomputed || this.generate();
        var sameFile = false, sameRank = false, ambiguous = false;
        for (var i = 0; i < others.length; i++) {
          var o = others[i];
          if (o.piece === move.piece && o.to === move.to && o.from !== move.from) {
            ambiguous = true;
            if (file(o.from) === file(move.from)) sameFile = true;
            if (rank(o.from) === rank(move.from)) sameRank = true;
          }
        }
        if (ambiguous) {
          if (!sameFile) out += 'abcdefgh'[file(move.from)];
          else if (!sameRank) out += String(8 - rank(move.from));
          else out += algebraic(move.from);
        }
      }
      if (move.flags & (FLAG.CAPTURE | FLAG.EP)) {
        if (move.piece === PAWN) out += 'abcdefgh'[file(move.from)];
        out += 'x';
      }
      out += algebraic(move.to);
      if (move.flags & FLAG.PROMO) out += '=' + SYM[move.promo].toUpperCase();
    }
    this.makeMove(move);
    if (this.inCheck()) out += this.generate().length === 0 ? '#' : '+';
    this.undoMove();
    return out;
  };

  Chess.prototype.moveFromSan = function (san) {
    var clean = san.replace(/[+#?!]+$/, '').replace(/[!?]/g, '').trim();
    var ms = this.generate();
    for (var i = 0; i < ms.length; i++) {
      var s = this.san(ms[i], ms).replace(/[+#]/g, '');
      if (s === clean) return ms[i];
    }
    // lenient: try uci
    var uci = clean.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
    if (uci) {
      for (var j = 0; j < ms.length; j++) {
        if (ms[j].fromSq === uci[1] && ms[j].toSq === uci[2] &&
            (!uci[3] || SYM[ms[j].promo] === uci[3].toLowerCase())) return ms[j];
      }
    }
    return null;
  };

  Chess.prototype.move = function (spec) {
    var m = typeof spec === 'string' ? this.moveFromSan(spec) : spec;
    if (!m) return null;
    var san = this.san(m);
    this.makeMove(m);
    m.san = san;
    return m;
  };

  Chess.prototype.get = function (sqName) {
    var p = this.board[sq0x88(sqName)];
    if (!p) return null;
    return { type: SYM[p & TYPE_MASK], color: (p & COLOR_MASK) === WHITE ? 'w' : 'b' };
  };

  Chess.prototype.gameOver = function () {
    var ms = this.generate();
    if (ms.length === 0) return this.inCheck() ? 'checkmate' : 'stalemate';
    if (this.halfmoves >= 100) return 'fifty';
    if (this.insufficient()) return 'material';
    return null;
  };

  Chess.prototype.insufficient = function () {
    var pieces = [], sq;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (this.board[sq]) pieces.push(this.board[sq] & TYPE_MASK);
    }
    if (pieces.length <= 2) return true;
    if (pieces.length === 3 && (pieces.indexOf(BISHOP) > -1 || pieces.indexOf(KNIGHT) > -1)) return true;
    return false;
  };

  Chess.prototype.turnColor = function () { return this.turn === WHITE ? 'w' : 'b'; };

  Chess.prototype.boardArray = function () {
    var out = [];
    for (var r = 0; r < 8; r++) {
      var row = [];
      for (var f = 0; f < 8; f++) {
        var p = this.board[r * 16 + f];
        row.push(p ? { type: SYM[p & TYPE_MASK], color: (p & COLOR_MASK) === WHITE ? 'w' : 'b', square: algebraic(r * 16 + f) } : null);
      }
      out.push(row);
    }
    return out;
  };

  /* ---------- PGN ---------- */
  function parsePgnTags(text) {
    var tags = {}, re = /\[(\w+)\s+"([^"]*)"\]/g, m;
    while ((m = re.exec(text))) tags[m[1]] = m[2];
    return tags;
  }

  // Returns {tags, moves:[{san, number, color, comment, nags}], result}
  Chess.parsePGN = function (pgn) {
    var tags = parsePgnTags(pgn);
    var body = pgn.replace(/\[[^\]]*\]\s*/g, '').trim();
    body = body.replace(/\{[^}]*\}/g, function (c) { return ' \u0001' + c.slice(1, -1).replace(/\s+/g, '\u0002') + '\u0001 '; });
    body = body.replace(/\([^()]*\)/g, ' '); // strip simple variations
    var tokens = body.split(/\s+/);
    var moves = [], pendingComment = null;
    var game = new Chess();
    var result = tags.Result || '*';
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      if (t[0] === '\u0001') { pendingComment = t.replace(/\u0001/g, '').replace(/\u0002/g, ' ').trim(); continue; }
      if (/^\d+\.+$/.test(t)) continue;
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) { result = t; continue; }
      if (/^\$\d+$/.test(t)) { if (moves.length) moves[moves.length - 1].nag = t; continue; }
      t = t.replace(/^\d+\.+/, '');
      if (!t) continue;
      var before = game.fen();
      var mv = game.move(t);
      if (!mv) { continue; }
      moves.push({
        san: mv.san, uci: mv.fromSq + mv.toSq + (mv.promo ? SYM[mv.promo] : ''),
        ply: moves.length + 1, color: mv.color === WHITE ? 'w' : 'b',
        fenBefore: before, fenAfter: game.fen(),
        captured: mv.captured ? SYM[mv.captured] : null,
        comment: pendingComment
      });
      pendingComment = null;
    }
    if (pendingComment && moves.length) moves[moves.length - 1].comment = pendingComment;
    return { tags: tags, moves: moves, result: result };
  };

  Chess.FLAG = FLAG;
  Chess.SYM = SYM;
  Chess.algebraic = algebraic;
  Chess.sq0x88 = sq0x88;
  Chess.WHITE = WHITE; Chess.BLACK = BLACK;
  Chess.PAWN = PAWN; Chess.KNIGHT = KNIGHT; Chess.BISHOP = BISHOP;
  Chess.ROOK = ROOK; Chess.QUEEN = QUEEN; Chess.KING = KING;
  Chess.TYPE_MASK = TYPE_MASK; Chess.COLOR_MASK = COLOR_MASK;

  root.Chess = Chess;
  if (typeof module !== 'undefined' && module.exports) module.exports = Chess;
})(typeof window !== 'undefined' ? window : globalThis);
