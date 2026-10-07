package server

import (
	"context"
	"sync"
	"time"
)

// Heartbeat tracks whether a page is still talking to the server. It is used
// when the UI runs in a browser window the shell does not own: the process
// then has to notice by itself that the page has gone away.
//
// Every authenticated API request counts as a beat (GET /api/ping exists so
// that an idle page can send one), and a request that is still being served
// keeps the server alive however long it takes.
type Heartbeat struct {
	mu     sync.Mutex
	now    func() time.Time
	start  time.Time
	last   time.Time
	seen   bool
	active int
}

// NewHeartbeat returns a tracker using the given clock (nil: time.Now).
func NewHeartbeat(now func() time.Time) *Heartbeat {
	if now == nil {
		now = time.Now
	}
	return &Heartbeat{now: now, start: now()}
}

// Restart forgets all beats and starts the "no beat ever" period again. Call
// it right before the browser is launched.
func (h *Heartbeat) Restart() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.start, h.seen = h.now(), false
}

// Begin records a beat and marks a request as running.
func (h *Heartbeat) Begin() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.active++
	h.seen, h.last = true, h.now()
}

// End marks a request as finished; that moment counts as a beat too.
func (h *Heartbeat) End() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.active > 0 {
		h.active--
	}
	h.last = h.now()
}

// Seen reports whether any beat has arrived since the last Restart.
func (h *Heartbeat) Seen() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.seen
}

// Expired reports whether the page should be considered gone: no beat for
// idle after at least one was received, or no beat at all for never.
func (h *Heartbeat) Expired(idle, never time.Duration) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.active > 0 {
		return false
	}
	now := h.now()
	if h.seen {
		return now.Sub(h.last) > idle
	}
	return now.Sub(h.start) > never
}

// Wait blocks until Expired reports true or ctx is done, checking every poll
// interval. It returns ctx.Err() in the second case.
func (h *Heartbeat) Wait(ctx context.Context, idle, never, poll time.Duration) error {
	t := time.NewTicker(poll)
	defer t.Stop()
	for {
		if h.Expired(idle, never) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
}
