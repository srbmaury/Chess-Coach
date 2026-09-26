// Click-to-move for react-chessboard: click one of the side-to-move's pieces to select
// it (legal destinations are marked), then click a destination to play the move.
// Dragging keeps working; both paths call the same move handler.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Chess, type Square } from 'chess.js'

type SquareClick = { square: string }
type MoveHandler = (sourceSquare: string, targetSquare: string) => boolean

const SELECTED: CSSProperties = { background: 'rgba(215, 255, 117, 0.45)' }
const TARGET: CSSProperties = { background: 'radial-gradient(circle, rgba(215, 255, 117, 0.55) 22%, transparent 24%)' }
const CAPTURE: CSSProperties = { background: 'radial-gradient(circle, transparent 58%, rgba(215, 255, 117, 0.55) 60%)' }

export function useClickToMove(fen: string | null | undefined) {
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => setSelected(null), [fen])

  const position = useMemo(() => {
    if (!fen) return null
    try {
      return new Chess(fen)
    } catch {
      return null
    }
  }, [fen])

  const targets = useMemo(() => {
    if (!position || !selected) return new Map<string, boolean>()
    return new Map(position.moves({ square: selected as Square, verbose: true })
      .map((move) => [move.to, Boolean(move.captured)] as const))
  }, [position, selected])

  function ownPiece(square: string): boolean {
    const piece = position?.get(square as Square)
    return Boolean(piece && piece.color === position?.turn())
  }

  return {
    selected,
    /** Selection highlights; merge over any existing square styles. */
    squareStyles(enabled: boolean): Record<string, CSSProperties> {
      if (!enabled || !selected) return {}
      const styles: Record<string, CSSProperties> = { [selected]: SELECTED }
      targets.forEach((capture, square) => { styles[square] = capture ? CAPTURE : TARGET })
      return styles
    },
    onSquareClick(enabled: boolean, onMove: MoveHandler) {
      return ({ square }: SquareClick) => {
        if (!enabled || !position) {
          setSelected(null)
          return
        }
        if (selected && targets.has(square)) {
          setSelected(null)
          onMove(selected, square)
          return
        }
        setSelected(ownPiece(square) && square !== selected ? square : null)
      }
    },
  }
}
