package server

import (
	"context"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

const (
	idle  = 15 * time.Second
	never = 60 * time.Second
)

func TestHeartbeatNeverSeen(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	h := NewHeartbeat(clock.Now)
	clock.Advance(59 * time.Second)
	if h.Expired(idle, never) {
		t.Error("expired before 60 s without any beat")
	}
	clock.Advance(2 * time.Second)
	if !h.Expired(idle, never) {
		t.Error("not expired after 60 s without any beat")
	}
	if h.Seen() {
		t.Error("Seen without a beat")
	}
}

func TestHeartbeatIdleAfterBeat(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	h := NewHeartbeat(clock.Now)
	clock.Advance(50 * time.Second)
	h.Begin()
	h.End()
	if !h.Seen() {
		t.Error("beat not seen")
	}
	clock.Advance(14 * time.Second) // 64 s after start, 14 s after the beat
	if h.Expired(idle, never) {
		t.Error("expired 14 s after a beat")
	}
	h.Begin()
	h.End()
	clock.Advance(14 * time.Second)
	if h.Expired(idle, never) {
		t.Error("expired although beats keep coming")
	}
	clock.Advance(2 * time.Second)
	if !h.Expired(idle, never) {
		t.Error("not expired 16 s after the last beat")
	}
}

func TestHeartbeatRunningRequestKeepsAlive(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	h := NewHeartbeat(clock.Now)
	h.Begin() // e.g. a long upload or an open folder dialog
	clock.Advance(10 * time.Minute)
	if h.Expired(idle, never) {
		t.Error("expired while a request is running")
	}
	h.End()
	clock.Advance(14 * time.Second)
	if h.Expired(idle, never) {
		t.Error("the end of a request must count as a beat")
	}
	clock.Advance(2 * time.Second)
	if !h.Expired(idle, never) {
		t.Error("not expired 16 s after the request ended")
	}
}

func TestHeartbeatRestart(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	h := NewHeartbeat(clock.Now)
	h.Begin()
	h.End()
	clock.Advance(time.Hour)
	h.Restart()
	if h.Seen() || h.Expired(idle, never) {
		t.Error("Restart must give a fresh 60 s period")
	}
	clock.Advance(61 * time.Second)
	if !h.Expired(idle, never) {
		t.Error("not expired 61 s after Restart")
	}
}

func TestHeartbeatWait(t *testing.T) {
	h := NewHeartbeat(nil)
	done := make(chan error, 1)
	go func() { done <- h.Wait(context.Background(), 30*time.Millisecond, time.Hour, 5*time.Millisecond) }()
	h.Begin()
	h.End()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Wait = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after the idle period")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := NewHeartbeat(nil).Wait(ctx, time.Hour, time.Hour, time.Millisecond); err != context.Canceled {
		t.Errorf("Wait with cancelled context = %v", err)
	}
}

// API requests feed the server's heartbeat; static files and rejected
// requests do not.
func TestAPIRequestsAreHeartbeats(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1000, 0)}
	e := newEnv(t, func(o *Options) { o.Now = clock.Now })
	hb := e.srv.Heartbeat()

	e.do("GET", "/", nil)
	e.do("GET", "/host.js", nil)
	e.do("GET", "/api/ping", nil, noToken)
	e.do("GET", "/api/ping", nil, withHost("evil.example:4321"))
	if hb.Seen() {
		t.Fatal("a static or rejected request counted as a heartbeat")
	}
	clock.Advance(61 * time.Second)
	if !hb.Expired(idle, never) {
		t.Fatal("should have expired without heartbeats")
	}

	e.do("GET", "/api/ping", nil)
	if !hb.Seen() || hb.Expired(idle, never) {
		t.Fatal("ping did not count as a heartbeat")
	}
	clock.Advance(10 * time.Second)
	e.do("GET", "/api/volumes", nil) // any authenticated API request counts
	clock.Advance(10 * time.Second)
	if hb.Expired(idle, never) {
		t.Fatal("an API request did not count as a heartbeat")
	}
	clock.Advance(6 * time.Second)
	if !hb.Expired(idle, never) {
		t.Fatal("should have expired 16 s after the last request")
	}
}
