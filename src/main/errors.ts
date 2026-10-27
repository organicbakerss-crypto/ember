import type { ErrorCode } from '@shared/ipc'

/** An error that is safe to show the user and travels across IPC as a code. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AppError'
  }
}
