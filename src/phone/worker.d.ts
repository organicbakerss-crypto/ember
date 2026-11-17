/** The phone reader's gatekeeper (plain JS, run by Cloudflare; see worker.js). */
declare const worker: {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>
}
export default worker
