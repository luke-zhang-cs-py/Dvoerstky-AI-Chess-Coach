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

  // 0x88 indices of the rooks' home squares: h1/a1 for White, h8/a8 for Black
  var ROOK_HOME = {};
  ROOK_HOME[WHITE] = { k: 119, q: 112 };
  ROOK_HOME[BLACK] = { k: 7, q: 0 };

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

  /* Reads a FEN, and throws an Error saying what is wrong with one that is not
     a position: a rank that is not 8 squares, an unknown piece, a side to move
     other than w or b, an en passant field that is not a square, a halfmove
     clock that is not a whole number, anything but one king a side. Missing
     fields default (a bare board is White to move, no rights, clocks 0 and 1).
     Two claims the board contradicts are dropped rather than refused: a
     castling right whose king or rook is not on its home square, and an en
     passant square no pawn can just have passed (the generator would otherwise
     "capture" an empty square, or a piece of the mover's own). */
  Chess.prototype.load = function (fen) {
    this.clear();
    var parts = String(fen).trim().split(/\s+/);
    var rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('FEN needs 8 ranks, got ' + rows.length + ': ' + fen);
    var sq = 0, kingCount = { 8: 0, 16: 0 };
    for (var r = 0; r < 8; r++) {
      var row = rows[r], width = 0; sq = r * 16;
      for (var i = 0; i < row.length; i++) {
        var c = row[i];
        if (/[1-8]/.test(c)) { sq += parseInt(c, 10); width += parseInt(c, 10); }
        else {
          var color = c === c.toUpperCase() ? WHITE : BLACK;
          var type = FROM_SYM[c.toLowerCase()];
          if (!type) throw new Error('FEN has an unknown piece "' + c + '": ' + fen);
          if (width >= 8) throw new Error('FEN rank ' + (8 - r) + ' is longer than 8 squares: ' + fen);
          this.board[sq] = type | color;
          if (type === KING) { this.kings[color] = sq; kingCount[color]++; }
          sq++; width++;
        }
      }
      if (width !== 8) throw new Error('FEN rank ' + (8 - r) + ' has ' + width + ' squares, not 8: ' + fen);
    }
    if (kingCount[WHITE] !== 1 || kingCount[BLACK] !== 1) {
      throw new Error('FEN needs one king a side, has ' + kingCount[WHITE] + ' white and ' + kingCount[BLACK] + ' black: ' + fen);
    }
    if (parts[1] !== undefined && parts[1] !== 'w' && parts[1] !== 'b') {
      throw new Error('FEN side to move must be w or b, not "' + parts[1] + '": ' + fen);
    }
    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    var cst = parts[2] || '-', b = this.board, self = this;
    // A right counts only with the king on e1/e8 and that rook in its corner.
    [WHITE, BLACK].forEach(function (col) {
      if (b[col === WHITE ? 116 : 4] !== (KING | col)) return;
      if (cst.indexOf(col === WHITE ? 'K' : 'k') > -1 && b[ROOK_HOME[col].k] === (ROOK | col)) self.castling[col] |= FLAG.KSIDE;
      if (cst.indexOf(col === WHITE ? 'Q' : 'q') > -1 && b[ROOK_HOME[col].q] === (ROOK | col)) self.castling[col] |= FLAG.QSIDE;
    });
    var ep = parts[3] || '-';
    if (ep !== '-' && !/^[a-h][1-8]$/.test(ep)) throw new Error('FEN en passant square "' + ep + '" is not a square: ' + fen);
    this.ep = ep === '-' ? -1 : sq0x88(ep);
    if (this.ep !== -1) {
      // White to move: the square is on the 6th rank, it and the 7th-rank square
      // behind it are empty, and a black pawn stands in front of it on the 5th.
      var them = this.turn === WHITE ? BLACK : WHITE, fwd = this.turn === WHITE ? 16 : -16;
      if (rank(this.ep) !== (this.turn === WHITE ? 2 : 5) || b[this.ep] || b[this.ep - fwd] ||
          b[this.ep + fwd] !== (PAWN | them)) this.ep = -1;
    }
    if (parts[4] !== undefined && !/^\d+$/.test(parts[4])) {
      throw new Error('FEN halfmove clock must be a whole number, not "' + parts[4] + '": ' + fen);
    }
    this.halfmoves = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;
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
    var k = this.kings[color];   // load() refuses a position without both kings
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
          } else if (cap === this.ep && b[cap - dir] === (PAWN | them)) {   // the pawn that just passed
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
    // a rook leaving its home square, or captured on it, ends that side's castling
    if (this.castling[us]) {
      if (m.from === ROOK_HOME[us].k) this.castling[us] &= ~FLAG.KSIDE;
      if (m.from === ROOK_HOME[us].q) this.castling[us] &= ~FLAG.QSIDE;
    }
    if (this.castling[them]) {
      if (m.to === ROOK_HOME[them].k) this.castling[them] &= ~FLAG.KSIDE;
      if (m.to === ROOK_HOME[them].q) this.castling[them] &= ~FLAG.QSIDE;
    }
    this.ep = (m.flags & FLAG.BIG_PAWN) ? (us === WHITE ? m.to + 16 : m.to - 16) : -1;
    if (m.piece === PAWN || (m.flags & (FLAG.CAPTURE | FLAG.EP))) this.halfmoves = 0;
    else this.halfmoves++;
    if (us === BLACK) this.movenumber++;
    this.turn = them;
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
    var clean = san.replace(/[+#?!]+$/, '').replace(/[!?]/g, '').trim()
      .replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O')     // zeros, as some programs write castling
      // a8Q and a8=q for a8=Q
      .replace(/^([a-h](?:x[a-h])?[18])=?([QRBNqrbn])$/, function (_, sq, pc) { return sq + '=' + pc.toUpperCase(); });
    var ms = this.generate();
    for (var i = 0; i < ms.length; i++) {
      var s = this.san(ms[i], ms).replace(/[+#]/g, '');
      if (s === clean) return ms[i];
    }
    // long algebraic, with the from-square: Ng1f3, Ng1-f3, Bf1xb5, e7e8=Q
    var lan = clean.match(/^([NBRQK])?([a-h][1-8])[-x]?([a-h][1-8])(?:=?([QRBNqrbn]))?$/);
    if (lan) {
      var piece = lan[1] ? FROM_SYM[lan[1].toLowerCase()] : 0;
      for (var k = 0; k < ms.length; k++) {
        var mv = ms[k];
        if (mv.fromSq !== lan[2] || mv.toSq !== lan[3]) continue;
        if (piece ? mv.piece !== piece : (lan[4] && mv.piece !== PAWN)) continue;
        if (lan[4] ? SYM[mv.promo] !== lan[4].toLowerCase() : mv.promo && mv.promo !== QUEEN) continue;
        return mv;
      }
    }
    // (UCI, e2e4 or e7e8q, is long algebraic without the piece letter: the loop above reads it.)
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
    if (this.repetitions() >= 3) return 'repetition';
    if (this.insufficient()) return 'material';
    return null;
  };

  /* A position, for repetition: where the pieces are, who is to move, the
     castling rights, and the en passant square -- but only when a capture
     onto it is actually legal (FIDE 9.2.2). After 1.e4 the FEN names e3 even
     when no black pawn could take there, and that must not make the
     position differ from the same one reached without the double push. */
  Chess.prototype.positionKey = function () {
    var f = this.fen().split(' ');
    if (f[3] !== '-' && !this.generate().some(function (m) { return m.flags & FLAG.EP; })) f[3] = '-';
    return f.slice(0, 4).join(' ');
  };

  /* How many times the current position has occurred in this game. Only the
     plies since the last capture or pawn move can match -- those are what the
     halfmove clock counts -- so it walks back that far, compares, and plays the
     same moves forward again, leaving the game exactly as it found it. */
  Chess.prototype.repetitions = function () {
    var now = this.positionKey(), count = 1, moves = [];
    var steps = Math.min(this.halfmoves, this.history.length);
    for (var i = 0; i < steps; i++) {
      moves.push(this.history[this.history.length - 1].move);
      this.undoMove();
      if (this.positionKey() === now) count++;
    }
    while (moves.length) this.makeMove(moves.pop());
    return count;
  };

  Chess.prototype.insufficient = function () {
    var pieces = [], sq;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (this.board[sq]) pieces.push(this.board[sq] & TYPE_MASK);
    }
    if (pieces.length <= 2) return true;
    if (pieces.length === 3 && (pieces.indexOf(BISHOP) > -1 || pieces.indexOf(KNIGHT) > -1)) return true;
    // Kings and bishops only, every bishop on one colour of square: nobody can
    // ever be mated (FIDE 5.2.2), however many bishops there are.
    var colours = {}, onlyBishops = true;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var t = this.board[sq] & TYPE_MASK;
      if (!t || t === KING) continue;
      if (t !== BISHOP) { onlyBishops = false; break; }
      colours[((sq >> 4) + (sq & 7)) % 2] = true;
    }
    return onlyBishops && Object.keys(colours).length === 1;
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
  /* PGN text -> tokens, in one pass, so each kind of text is read by its own
     rule wherever it appears: {brace comments} (which may hold [%eval ...] and
     ";" without either meaning anything), "; to the end of the line" comments,
     "%" escape lines (a % in the first column), [Tag "value"] pairs, the
     parentheses of variations, and words (move numbers, moves, NAGs, results). */
  var TAG_RE = /\[\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]/y;
  function pgnTokens(text) {
    var out = [], i = 0, n = text.length, c, j;
    while (i < n) {
      c = text[i];
      if (c === '%' && (i === 0 || text[i - 1] === '\n')) { j = text.indexOf('\n', i); i = j < 0 ? n : j; continue; }
      if (c === ';') { j = text.indexOf('\n', i); i = j < 0 ? n : j; continue; }
      if (c === '{') {
        j = text.indexOf('}', i);
        out.push({ t: 'comment', text: text.slice(i + 1, j < 0 ? n : j).replace(/\s+/g, ' ').trim() });
        i = j < 0 ? n : j + 1; continue;
      }
      if (c === '[') {
        TAG_RE.lastIndex = i;
        var m = TAG_RE.exec(text);
        if (m) { out.push({ t: 'tag', name: m[1], value: m[2].replace(/\\(["\\])/g, '$1') }); i = TAG_RE.lastIndex; continue; }
        i++; continue;
      }
      if (c === '(' || c === ')') { out.push({ t: c }); i++; continue; }
      if (/\s|[\]}]/.test(c)) { i++; continue; }
      j = i;
      while (j < n && !/[\s{}()\[\];]/.test(text[j])) j++;
      out.push({ t: 'word', text: text.slice(i, j) });
      i = j;
    }
    return out;
  }

  // Returns {tags, moves:[{san, uci, ply, color, fenBefore, fenAfter, captured, comment, nag}], result}
  var RESULTS = /^(1-0|0-1|1\/2-1\/2|\*)$/;

  /* One game: the first in the text. It ends at its result token, or where a
     new tag section starts after its moves; anything after that is ignored, so
     a file of many games must be split first (Data.importPGN does).
     A move that cannot be played is an Error naming it: the moves after it
     would be read from the wrong position, so the game is not silently cut
     short or continued past the hole. */
  Chess.parsePGN = function (pgn) {
    var tokens = pgnTokens(String(pgn).replace(/\r\n?/g, '\n'));
    var tags = {}, moves = [], game = null, tokenResult = null, started = false, depth = 0;
    for (var i = 0; i < tokens.length && !tokenResult; i++) {
      var tok = tokens[i];
      if (tok.t === 'tag') {
        if (started) break;   // the next game's tags
        tags[tok.name] = tok.value;
        continue;
      }
      started = true;
      if (tok.t === '(') { depth++; continue; }
      if (tok.t === ')') { if (depth) depth--; continue; }
      if (depth) continue;   // variations stay out of the main line
      if (tok.t === 'comment') {
        // A comment describes the move it follows; one before the first move
        // is about the game and has no move to go with.
        if (moves.length) moves[moves.length - 1].comment = tok.text;
        continue;
      }
      var t = tok.text;
      if (/^\d+\.+$/.test(t) || /^\.+$/.test(t)) continue;
      if (RESULTS.test(t)) { tokenResult = t; continue; }
      if (/^\$\d+$/.test(t)) { if (moves.length) moves[moves.length - 1].nag = t; continue; }
      t = t.replace(/^\d+\.+/, '');
      if (!t || /^[!?]+$/.test(t) || /^e\.p\.?$/i.test(t)) continue;   // a detached annotation, "exd6 e.p."
      if (!game) game = new Chess(tags.FEN || undefined);
      var before = game.fen();
      var mv = game.move(t);
      if (!mv) {
        throw new Error('PGN: cannot play "' + t + '" at move ' + game.movenumber +
          (game.turn === WHITE ? ' (White)' : ' (Black)') + ' from ' + before);
      }
      moves.push({
        san: mv.san, uci: mv.fromSq + mv.toSq + (mv.promo ? SYM[mv.promo] : ''),
        ply: moves.length + 1, color: mv.color === WHITE ? 'w' : 'b',
        fenBefore: before, fenAfter: game.fen(),
        captured: mv.captured ? SYM[mv.captured] : null,
        comment: null
      });
    }
    var result = tokenResult || (RESULTS.test(tags.Result || '') ? tags.Result : '*');
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
