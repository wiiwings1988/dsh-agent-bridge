/**
 * Newline splitting of a child process's output stream.
 * @module dsh-agent-bridge/lines
 */

/**
 * Collects stream chunks and hands back each completed line. Only the newly arrived chunk is
 * searched for a newline, so a line of many megabytes arriving in thousands of chunks costs time
 * in proportion to its length (the Codex app-server answers a thread read with one such line).
 */
export class LineSplitter {
  private pending: string[] = []

  /**
   * Add one chunk.
   * @param chunk - text as it arrived.
   * @returns the lines this chunk completed, without their newlines.
   */
  push(chunk: string): string[] {
    const lines: string[] = []
    let start = 0
    let index = chunk.indexOf('\n')
    while (index >= 0) {
      this.pending.push(chunk.slice(start, index))
      lines.push(this.pending.join(''))
      this.pending = []
      start = index + 1
      index = chunk.indexOf('\n', start)
    }
    if (start < chunk.length) this.pending.push(chunk.slice(start))
    return lines
  }

  /** Drop the unfinished line, for example when the process exits. */
  reset(): void {
    this.pending = []
  }
}
