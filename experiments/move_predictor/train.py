"""
Standalone experiment: predict ermactually's move choices with a small CNN,
instead of hand-coding evaluation rules the way js/engine.js does.

Not wired into the app. Data is 33 of ermactually's own Lichess games (see
README.md in this folder for why only 33, and only this account).

Usage: python train.py
Requires: pip install torch python-chess
"""
import random
import chess
import chess.pgn
import torch
import torch.nn as nn
import torch.nn.functional as F

USERNAME = "ermactually"
PGN_PATH = "ermactually_games.pgn"
SEED = 0

random.seed(SEED)
torch.manual_seed(SEED)


# ---------------------------------------------------------------------------
# Data: (position, move) pairs, one per ply where USERNAME was the mover.
#
# Boards are always encoded from the mover's point of view (python-chess's
# board.mirror(): flips ranks and swaps colours), so the network only ever
# has to learn "what does White-to-move play here" -- it never has to learn
# a separate White-repertoire and Black-repertoire. Moves are labelled with
# the same transform via pov_action() below, so a label always lines up
# with the board frame it was played from. Promotion piece choice is
# dropped from the label (just from-square/to-square, 64*64=4096 classes) --
# with this little data, distinguishing "e7e8=Q" from "e7e8=N" isn't worth
# the extra label complexity, and queen promotion dominates anyway.
# ---------------------------------------------------------------------------

def encode_board(pov_board):
    """12x8x8 float tensor: plane = colour*6 + (piece_type-1). Caller must
    pass a board already in mover-as-White frame (see pov_action)."""
    t = torch.zeros(12, 8, 8)
    for sq, piece in pov_board.piece_map().items():
        plane = (0 if piece.color == chess.WHITE else 6) + (piece.piece_type - 1)
        r, f = chess.square_rank(sq), chess.square_file(sq)
        t[plane, r, f] = 1.0
    return t


def pov_action(move, white_to_move):
    """Action index (from*64+to), transformed into the mover-as-White frame."""
    if white_to_move:
        return move.from_square * 64 + move.to_square
    return chess.square_mirror(move.from_square) * 64 + chess.square_mirror(move.to_square)


def iter_username_plies(pgn_path, username):
    """Yields (board_before_move, move, white_to_move) for every ply in the
    file where `username` was the mover, replaying each game exactly once."""
    with open(pgn_path, encoding="utf-8") as f:
        while True:
            game = chess.pgn.read_game(f)
            if game is None:
                return
            white = game.headers.get("White", "")
            black = game.headers.get("Black", "")
            if username.lower() not in (white.lower(), black.lower()):
                continue
            if game.headers.get("Variant", "Standard") != "Standard":
                continue
            my_color = chess.WHITE if white.lower() == username.lower() else chess.BLACK
            board = game.board()
            game_had_ply = False
            for move in game.mainline_moves():
                if board.turn == my_color:
                    yield board, move, (board.turn == chess.WHITE), game_had_ply
                    game_had_ply = True
                board.push(move)


def load_examples(pgn_path, username):
    examples = []      # (board_tensor, action_index)
    game_spans = []     # (start, end) index ranges into `examples`, one per game -- for a leak-free train/val split
    game_start = 0
    for board, move, white_to_move, is_continuation in iter_username_plies(pgn_path, username):
        if not is_continuation and examples:
            game_spans.append((game_start, len(examples)))
            game_start = len(examples)
        pov_board = board if white_to_move else board.mirror()
        examples.append((encode_board(pov_board), pov_action(move, white_to_move)))
    if len(examples) > game_start:
        game_spans.append((game_start, len(examples)))
    return examples, game_spans


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------

class PolicyNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(12, 32, 3, padding=1), nn.ReLU(),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(),
            nn.Conv2d(64, 64, 3, padding=1), nn.ReLU(),
        )
        self.head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 8 * 8, 256), nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(256, 4096),
        )

    def forward(self, x):
        return self.head(self.conv(x))


# ---------------------------------------------------------------------------
# Legal-move-restricted accuracy: rather than just "did argmax over all 4096
# classes match", also score "among the moves actually legal here, did the
# highest-scoring one match" -- a fairer measure of whether the network
# learned anything chess-shaped versus raw square bias.
# ---------------------------------------------------------------------------

def legal_topk_hit(logits, board, played_action, k):
    white_to_move = board.turn == chess.WHITE
    legal_actions = list({pov_action(mv, white_to_move) for mv in board.legal_moves})
    scores = sorted(((logits[a].item(), a) for a in legal_actions), reverse=True)
    top_actions = [a for _, a in scores[:k]]
    return played_action in top_actions


def main():
    examples, game_spans = load_examples(PGN_PATH, USERNAME)
    print(f"games contributing examples: {len(game_spans)}")
    print(f"total ({USERNAME}-only) positions: {len(examples)}")

    if len(examples) < 50:
        print("Too few examples to train anything meaningful -- stopping.")
        return

    # split by GAME, not by position, so adjacent (highly correlated)
    # positions from the same game can't leak across train/val
    rng = random.Random(SEED)
    order = list(range(len(game_spans)))
    rng.shuffle(order)
    n_val_games = max(1, len(order) // 5)
    val_game_idx = set(order[:n_val_games])

    train_idx, val_idx = [], []
    for i, (s, e) in enumerate(game_spans):
        (val_idx if i in val_game_idx else train_idx).extend(range(s, e))

    print(f"train positions: {len(train_idx)} | val positions: {len(val_idx)} "
          f"({n_val_games}/{len(game_spans)} games held out)")

    X = torch.stack([ex[0] for ex in examples])
    y = torch.tensor([ex[1] for ex in examples], dtype=torch.long)

    model = PolicyNet()
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)

    train_idx_t = torch.tensor(train_idx)
    val_idx_t = torch.tensor(val_idx)
    batch_size = 32
    epochs = 40
    for epoch in range(1, epochs + 1):
        model.train()
        perm = train_idx_t[torch.randperm(len(train_idx_t))]
        total_loss = 0.0
        for i in range(0, len(perm), batch_size):
            batch = perm[i:i + batch_size]
            logits = model(X[batch])
            loss = F.cross_entropy(logits, y[batch])
            opt.zero_grad(); loss.backward(); opt.step()
            total_loss += loss.item() * len(batch)
        if epoch % 10 == 0 or epoch == epochs:
            train_loss = total_loss / len(train_idx)
            model.eval()
            with torch.no_grad():
                val_logits = model(X[val_idx_t])
                val_loss = F.cross_entropy(val_logits, y[val_idx_t]).item()
                val_acc = (val_logits.argmax(1) == y[val_idx_t]).float().mean().item()
            print(f"epoch {epoch:3d}  train_loss={train_loss:.3f}  val_loss={val_loss:.3f}  val_top1_raw={val_acc:.1%}")

    # Legal-move-restricted evaluation needs the actual board at each val
    # position, so replay the file again rather than reconstructing from tensors.
    model.eval()
    hits1 = hits3 = total = 0
    val_position_set = set(val_idx)
    pos = -1
    for board, move, white_to_move, _ in iter_username_plies(PGN_PATH, USERNAME):
        pos += 1
        if pos not in val_position_set:
            continue
        pov_board = board if white_to_move else board.mirror()
        with torch.no_grad():
            logits = model(encode_board(pov_board).unsqueeze(0))[0]
        played_action = pov_action(move, white_to_move)
        total += 1
        hits1 += legal_topk_hit(logits, board, played_action, 1)
        hits3 += legal_topk_hit(logits, board, played_action, 3)

    print(f"\nlegal-move-restricted val accuracy over {total} positions:")
    print(f"  top-1: {hits1 / total:.1%}   top-3: {hits3 / total:.1%}")
    print("\nFor scale: a uniform-random legal move in a typical middlegame position "
          "(~35 legal moves) would score roughly top-1 ~3%, top-3 ~9%.")


if __name__ == "__main__":
    main()
