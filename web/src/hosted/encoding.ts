// gzip JSON documents for Storage using the platform CompressionStream, with bounded
// decompression so a hostile object cannot exhaust memory.

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error('Decompressed data exceeds the size limit')
    }
    chunks.push(value)
  }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function streamOf(bytes: Uint8Array): ReadableStream<BufferSource> {
  return new Blob([bytes as BlobPart]).stream()
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return collect(streamOf(bytes).pipeThrough(new CompressionStream('gzip')), Number.MAX_SAFE_INTEGER)
}

export async function gunzip(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  return collect(streamOf(bytes).pipeThrough(new DecompressionStream('gzip')), limit)
}

export async function gzipJson(document: unknown): Promise<Uint8Array> {
  return gzip(new TextEncoder().encode(JSON.stringify(document)))
}

export async function gunzipJson<T>(bytes: Uint8Array, limit: number): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await gunzip(bytes, limit))) as T
}
