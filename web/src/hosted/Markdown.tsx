// A deliberately small Markdown renderer for coaching reports: headings, paragraphs,
// bullet lists, pipe tables, **bold**, _emphasis_, and http(s) links. It builds React
// elements (never HTML strings), so report content cannot inject markup.
import type { ReactNode } from 'react'

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|_(.+?)_/g
  let last = 0
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const key = `${keyPrefix}-${index++}`
    if (match[1] !== undefined) nodes.push(<strong key={key}>{match[1]}</strong>)
    else if (match[2] !== undefined) nodes.push(<a key={key} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>)
    else nodes.push(<em key={key}>{match[4]}</em>)
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim())

export default function Markdown({ source }: { source: string }) {
  const lines = source.split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const key = `block-${index}`
    if (!line.trim()) {
      index += 1
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(' ')
      const content = inline(line.slice(level + 1), key)
      blocks.push(level === 1 ? <h2 key={key}>{content}</h2> : <h3 key={key}>{content}</h3>)
      index += 1
    } else if (line.startsWith('- ')) {
      const items: ReactNode[] = []
      while (index < lines.length && lines[index].startsWith('- ')) {
        items.push(<li key={index}>{inline(lines[index].slice(2), `li-${index}`)}</li>)
        index += 1
      }
      blocks.push(<ul key={key}>{items}</ul>)
    } else if (line.startsWith('|') && lines[index + 1]?.startsWith('| ---')) {
      const header = cells(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && lines[index].startsWith('|')) {
        rows.push(cells(lines[index]))
        index += 1
      }
      blocks.push(
        <div className="hosted-table" key={key}>
          <table>
            <thead><tr>{header.map((cell, column) => <th key={column}>{cell}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{inline(cell, `${key}-${rowIndex}-${column}`)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>,
      )
    } else {
      blocks.push(<p key={key}>{inline(line, key)}</p>)
      index += 1
    }
  }
  return <div className="hosted-markdown">{blocks}</div>
}
