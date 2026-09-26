// Python-compatible formatting so browser-built reports match the Python pipeline
// byte for byte. Python rounds the exact binary value half-to-even; JavaScript's
// toFixed rounds exact ties away from zero, so fixed-point formatting is done here
// with BigInt arithmetic on the exact IEEE-754 value.

function exactParts(value: number): { negative: boolean; mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value)
  const high = view.getUint32(0)
  const low = view.getUint32(4)
  const negative = high >>> 31 === 1
  const biased = (high >>> 20) & 0x7ff
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low)
  let exponent: number
  if (biased === 0) {
    exponent = -1074
  } else {
    mantissa |= 1n << 52n
    exponent = biased - 1075
  }
  return { negative, mantissa, exponent }
}

/** Python's `f"{value:.{digits}f}"`. */
export function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf'
  const { negative, mantissa, exponent } = exactParts(value)
  const scale = 10n ** BigInt(digits)
  let rounded: bigint
  if (exponent >= 0) {
    rounded = (mantissa << BigInt(exponent)) * scale
  } else {
    const numerator = mantissa * scale
    const denominator = 1n << BigInt(-exponent)
    const quotient = numerator / denominator
    const remainder = numerator % denominator
    const twice = remainder * 2n
    rounded = twice > denominator || (twice === denominator && quotient % 2n === 1n)
      ? quotient + 1n
      : quotient
  }
  let text = rounded.toString()
  if (digits > 0) {
    text = text.padStart(digits + 1, '0')
    text = `${text.slice(0, -digits)}.${text.slice(-digits)}`
  }
  return negative ? `-${text}` : text
}

/** Python's `f"{value:+.{digits}f}"`. */
export function formatSigned(value: number, digits: number): string {
  const text = formatFixed(value, digits)
  return text.startsWith('-') ? text : `+${text}`
}

/** Python's `f"{value:.{digits}%}"`. */
export function formatPercent(value: number, digits: number): string {
  return `${formatFixed(value * 100, digits)}%`
}

/** Python's `str.title()` for the ASCII labels used in reports. */
export function pyTitle(text: string): string {
  let result = ''
  let previousCased = false
  for (const character of text) {
    const cased = character.toLowerCase() !== character.toUpperCase()
    result += cased ? (previousCased ? character.toLowerCase() : character.toUpperCase()) : character
    previousCased = cased
  }
  return result
}

/** Python's `str(float)` for finite values (shortest round-trip repr). */
export function pyFloatString(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return `${value}.0`
  const text = String(value)
  const match = /^(-?[\d.]+)e([+-])(\d+)$/.exec(text)
  if (!match) return text
  const exponent = match[3].padStart(2, '0')
  return `${match[1]}e${match[2]}${exponent}`
}

/** Python's `round(value, 2)` for the cpl/100 values used by puzzles. */
export function pyRound2(value: number): number {
  return Number(formatFixed(value, 2))
}
