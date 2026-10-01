/** Runtime review facts over Connection's authenticated, transport-independent Fetch seam. */
export const LIVE_REVIEW_PATH = '/api/escalation-review.live'

export function createLiveReviewRoute(store, lifetime, waitMs = 25000) {
  const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return {
    path: LIVE_REVIEW_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('sessionId')
      const callId = url.searchParams.get('callId')
      if (!sessionId || !callId || sessionId.length > 256 || callId.length > 512) {
        return new Response('Invalid review identity', { status: 400 })
      }
      const signal = AbortSignal.any([request.signal, lifetime])
      const version = () => `${generation}:${store.revision(sessionId)}`
      if (url.searchParams.get('cursor') === version() && !signal.aborted) {
        await new Promise(resolve => {
          let timer
          let unsubscribe = () => {}
          const done = () => {
            clearTimeout(timer)
            unsubscribe()
            signal.removeEventListener('abort', done)
            resolve()
          }
          unsubscribe = store.subscribe(sessionId, done)
          signal.addEventListener('abort', done, { once: true })
          timer = setTimeout(done, waitMs)
          if (signal.aborted || url.searchParams.get('cursor') !== version()) done()
        })
      }
      if (signal.aborted) return new Response(null, { status: 499 })
      const snapshot = store.snapshot(sessionId)
      const bucket = Object.create(null)
      if (Object.hasOwn(snapshot, '$gate')) bucket.$gate = snapshot.$gate
      if (callId !== '$gate' && Object.hasOwn(snapshot, callId)) bucket[callId] = snapshot[callId]
      return Response.json({ cursor: version(), bucket }, { headers: { 'cache-control': 'no-store' } })
    },
  }
}
