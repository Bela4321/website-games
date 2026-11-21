// Pure tic-tac-toe rules, no I/O. Cells are numbered 0..8, row by row.

export type Mark = "X" | "O";
export type Cell = Mark | null;

export interface Game {
  board: Cell[];
  turn: Mark;
  starter: Mark;
  winner: Mark | "draw" | null;
  line: number[] | null; // winning cells, for highlighting
}

const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6], //           diagonals
];

export const other = (m: Mark): Mark => (m === "X" ? "O" : "X");

export function newGame(starter: Mark): Game {
  return { board: Array(9).fill(null), turn: starter, starter, winner: null, line: null };
}

export type MoveResult = { ok: true; game: Game } | { ok: false; error: string };

export function applyMove(game: Game, mark: Mark, cell: unknown): MoveResult {
  if (game.winner) return { ok: false, error: "The game is over." };
  if (game.turn !== mark) return { ok: false, error: "It's not your turn." };
  if (!Number.isInteger(cell) || (cell as number) < 0 || (cell as number) > 8) {
    return { ok: false, error: "That square doesn't exist." };
  }
  const i = cell as number;
  if (game.board[i]) return { ok: false, error: "That square is taken." };

  const board = game.board.slice();
  board[i] = mark;
  const line = LINES.find((l) => l.every((j) => board[j] === mark)) ?? null;
  const winner = line ? mark : board.every(Boolean) ? "draw" : null;
  return { ok: true, game: { ...game, board, turn: other(mark), winner, line } };
}
