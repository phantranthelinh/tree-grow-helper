/**
 * Incremental scanner for the LLM's streamed decision JSON. It consumes raw
 * text deltas and emits the decoded content of the top-level "message" string
 * field as it arrives, plus completion events for the top-level "type"/"tool"
 * string fields — WITHOUT waiting for the JSON to be complete or valid. The
 * caller still parses `raw()` with a real JSON parser at stream end; this
 * scanner is only for early emission, so it is lenient about malformed input
 * (it stops emitting rather than throwing).
 */

export type ScanEvent =
  | { kind: 'message'; text: string }
  | { kind: 'field'; key: 'type' | 'tool'; value: string }
  | { kind: 'end' }

type Container =
  // pre-key: expecting a key string (or '}'); post-key: expecting ':';
  // pre-value: expecting a value; post-value: expecting ',' or close.
  | { type: 'obj'; phase: 'pre-key' | 'post-key' | 'pre-value' | 'post-value' }
  | { type: 'arr'; phase: 'pre-value' | 'post-value' }

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

export class JsonStringFieldStreamer {
  private allText = ''
  private stack: Container[] = []
  private started = false
  private done = false

  // String state. `escape` is null (none), 'char' (just saw a backslash) or
  // 'hex' (inside \uXXXX, collecting hexBuf).
  private inString = false
  private stringMode: 'key' | 'value' = 'key'
  private escape: 'char' | 'hex' | null = null
  private hexBuf = ''

  private inPrimitive = false

  // Top-level (depth-1) field tracking.
  private keyBuf = ''
  private currentTopKey: string | null = null
  private capturingMessage = false
  private fieldKey: 'type' | 'tool' | null = null
  private fieldBuf = ''
  private msgBuf = ''

  /** Feed one raw delta; returns zero or more events, in order. */
  push(delta: string): ScanEvent[] {
    this.allText += delta
    const events: ScanEvent[] = []
    if (this.done) return events
    for (let i = 0; i < delta.length && !this.done; i++) {
      this.step(delta[i] as string, events)
    }
    this.flushMessage(events)
    return events
  }

  /** Everything consumed so far, verbatim — hand this to the JSON parser at stream end. */
  raw(): string {
    return this.allText
  }

  private step(ch: string, events: ScanEvent[]): void {
    if (!this.started) {
      if (ch === '{') {
        this.started = true
        this.stack.push({ type: 'obj', phase: 'pre-key' })
      }
      return
    }

    if (this.inString) {
      this.stepInString(ch, events)
      return
    }

    if (this.inPrimitive) {
      if (ch === ',' || ch === '}' || ch === ']' || /\s/.test(ch)) {
        this.inPrimitive = false
        this.setTopPhase('post-value')
        if (/\s/.test(ch)) return
        // fall through: the delimiter itself still needs structural handling
      } else {
        return
      }
    }

    const top = this.stack[this.stack.length - 1]
    switch (ch) {
      case '"': {
        if (top?.type === 'obj' && top.phase === 'pre-key') {
          this.stringMode = 'key'
          this.keyBuf = ''
        } else {
          this.stringMode = 'value'
          const isTopLevelValue = this.stack.length === 1 && top?.type === 'obj'
          this.capturingMessage = isTopLevelValue && this.currentTopKey === 'message'
          this.fieldKey =
            isTopLevelValue && (this.currentTopKey === 'type' || this.currentTopKey === 'tool')
              ? this.currentTopKey
              : null
          this.fieldBuf = ''
        }
        this.inString = true
        this.escape = null
        break
      }
      case '{':
        this.stack.push({ type: 'obj', phase: 'pre-key' })
        break
      case '[':
        this.stack.push({ type: 'arr', phase: 'pre-value' })
        break
      case '}':
      case ']': {
        this.stack.pop()
        if (this.stack.length === 0) {
          this.done = true
          this.flushMessage(events)
          events.push({ kind: 'end' })
        } else {
          this.setTopPhase('post-value')
        }
        break
      }
      case ':':
        if (top?.type === 'obj') top.phase = 'pre-value'
        break
      case ',':
        if (top?.type === 'obj') top.phase = 'pre-key'
        else if (top) top.phase = 'pre-value'
        break
      default:
        if (!/\s/.test(ch)) this.inPrimitive = true
    }
  }

  private stepInString(ch: string, events: ScanEvent[]): void {
    if (this.escape === 'char') {
      if (ch === 'u') {
        this.escape = 'hex'
        this.hexBuf = ''
      } else {
        this.appendDecoded(ESCAPES[ch] ?? ch)
        this.escape = null
      }
      return
    }
    if (this.escape === 'hex') {
      this.hexBuf += ch
      if (this.hexBuf.length === 4) {
        const code = Number.parseInt(this.hexBuf, 16)
        if (!Number.isNaN(code)) this.appendDecoded(String.fromCharCode(code))
        this.escape = null
      }
      return
    }
    if (ch === '\\') {
      this.escape = 'char'
      return
    }
    if (ch === '"') {
      this.inString = false
      this.endString(events)
      return
    }
    this.appendDecoded(ch)
  }

  private appendDecoded(text: string): void {
    if (this.stringMode === 'key') {
      if (this.stack.length === 1) this.keyBuf += text
      return
    }
    if (this.capturingMessage) this.msgBuf += text
    else if (this.fieldKey) this.fieldBuf += text
  }

  private endString(events: ScanEvent[]): void {
    if (this.stringMode === 'key') {
      this.setTopPhase('post-key')
      if (this.stack.length === 1) this.currentTopKey = this.keyBuf
      return
    }
    this.setTopPhase('post-value')
    this.capturingMessage = false
    if (this.fieldKey) {
      this.flushMessage(events)
      events.push({ kind: 'field', key: this.fieldKey, value: this.fieldBuf })
      this.fieldKey = null
    }
  }

  private setTopPhase(phase: 'post-key' | 'post-value'): void {
    const top = this.stack[this.stack.length - 1]
    if (!top) return
    if (top.type === 'obj') top.phase = phase
    else if (phase === 'post-value') top.phase = 'post-value'
  }

  private flushMessage(events: ScanEvent[]): void {
    if (this.msgBuf) {
      events.push({ kind: 'message', text: this.msgBuf })
      this.msgBuf = ''
    }
  }
}
