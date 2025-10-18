package main

import (
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

var (
	ErrRoomIDRequired            = errors.New("roomId is required")
	ErrPasswordRequired          = errors.New("password is required when creating a room")
	ErrIncorrectPassword         = errors.New("incorrect password for room")
	ErrCountdownDurationRequired = errors.New("countdown mode requires a positive duration")
	ErrUnknownMode               = errors.New("unknown room mode")
)

type RoomMode string

const (
	ModePermanent RoomMode = "permanent"
	ModeCountdown RoomMode = "countdown"
)

func ParseRoomMode(input string) (RoomMode, error) {
	switch RoomMode(input) {
	case ModeCountdown:
		return ModeCountdown, nil
	case ModePermanent, "":
		return ModePermanent, nil
	default:
		return "", ErrUnknownMode
	}
}

type Room struct {
	id        string
	password  string
	mode      RoomMode
	expiresAt time.Time

	mu      sync.RWMutex
	content string
	clients map[*Client]struct{}
	cursors map[string]CursorState
}

type RoomSnapshot struct {
	Content   string
	Mode      RoomMode
	ExpiresAt time.Time
	Cursors   map[string]CursorState
}

type OutgoingMessage struct {
	Type        string                 `json:"type"`
	Content     string                 `json:"content,omitempty"`
	Mode        RoomMode               `json:"mode,omitempty"`
	ExpiresAt   string                 `json:"expiresAt,omitempty"`
	Reason      string                 `json:"reason,omitempty"`
	ClientID    string                 `json:"clientId,omitempty"`
	CursorStart int                    `json:"cursorStart,omitempty"`
	CursorEnd   int                    `json:"cursorEnd,omitempty"`
	Cursors     map[string]CursorState `json:"cursors,omitempty"`
}

type CursorState struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

func NewRoom(id, password string, mode RoomMode, duration time.Duration) *Room {
	room := &Room{
		id:       id,
		password: password,
		mode:     mode,
		clients:  make(map[*Client]struct{}),
		cursors:  make(map[string]CursorState),
	}
	if mode == ModeCountdown {
		room.expiresAt = time.Now().Add(duration)
	}
	return room
}

func (r *Room) Snapshot() RoomSnapshot {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return RoomSnapshot{
		Content:   r.content,
		Mode:      r.mode,
		ExpiresAt: r.expiresAt,
		Cursors:   r.copyCursorsLocked(),
	}
}

func (r *Room) CheckPassword(password string) bool {
	return r.password == password
}

func (r *Room) UpdateContent(clientID, content string) {
	r.mu.Lock()
	r.content = content
	r.mu.Unlock()
	r.broadcast(OutgoingMessage{Type: "content", Content: content, ClientID: clientID})
}

func (r *Room) AddClient(client *Client) {
	snapshot := r.Snapshot()

	r.mu.Lock()
	r.clients[client] = struct{}{}
	r.mu.Unlock()

	client.enqueue(snapshotMessage(snapshot))
}

func (r *Room) RemoveClient(client *Client) {
	r.mu.Lock()
	delete(r.clients, client)
	if client.id != "" {
		delete(r.cursors, client.id)
	}
	r.mu.Unlock()
	if client.id != "" {
		r.broadcast(OutgoingMessage{
			Type:        "cursor",
			ClientID:    client.id,
			CursorStart: -1,
			CursorEnd:   -1,
		})
	}
}

func (r *Room) broadcast(msg OutgoingMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	r.mu.RLock()
	clients := make([]*Client, 0, len(r.clients))
	for c := range r.clients {
		clients = append(clients, c)
	}
	r.mu.RUnlock()

	for _, client := range clients {
		client.enqueue(data)
	}
}

func (r *Room) Close(reason string) {
	r.broadcast(OutgoingMessage{Type: "room_closed", Reason: reason})

	r.mu.Lock()
	clients := make([]*Client, 0, len(r.clients))
	for c := range r.clients {
		clients = append(clients, c)
	}
	r.clients = make(map[*Client]struct{})
	r.mu.Unlock()

	for _, client := range clients {
		client.close()
	}
}

func (r *Room) IsCountdown() bool {
	return r.mode == ModeCountdown
}

func (r *Room) Remaining() time.Duration {
	if !r.IsCountdown() {
		return 0
	}
	return time.Until(r.expiresAt)
}

func (r *Room) IsExpired() bool {
	if !r.IsCountdown() {
		return false
	}
	return time.Now().After(r.expiresAt)
}

type RoomManager struct {
	mu     sync.RWMutex
	rooms  map[string]*Room
	timers map[string]*time.Timer
}

func NewRoomManager() *RoomManager {
	return &RoomManager{
		rooms:  make(map[string]*Room),
		timers: make(map[string]*time.Timer),
	}
}

func (m *RoomManager) JoinOrCreateRoom(id, password string, mode RoomMode, duration time.Duration) (*Room, bool, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil, false, ErrRoomIDRequired
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if room, ok := m.rooms[id]; ok {
		if room.IsCountdown() && room.IsExpired() {
			delete(m.rooms, id)
			m.stopTimerLocked(id)
			go room.Close("expired")
			// treat as new room after cleanup
		} else {
			if !room.CheckPassword(password) {
				return nil, false, ErrIncorrectPassword
			}
			return room, false, nil
		}
	}

	if password == "" {
		return nil, false, ErrPasswordRequired
	}
	if mode == ModeCountdown && duration <= 0 {
		return nil, false, ErrCountdownDurationRequired
	}

	room := NewRoom(id, password, mode, duration)
	m.rooms[id] = room

	if mode == ModeCountdown {
		m.scheduleExpirationLocked(id, duration)
	}

	return room, true, nil
}

func (m *RoomManager) getRoom(id string) (*Room, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	room, ok := m.rooms[id]
	return room, ok
}

func (m *RoomManager) expireRoom(id string) {
	var room *Room

	m.mu.Lock()
	if r, ok := m.rooms[id]; ok {
		if r.IsCountdown() {
			room = r
			delete(m.rooms, id)
		}
	}
	m.stopTimerLocked(id)
	m.mu.Unlock()

	if room != nil {
		room.Close("expired")
	}
}

func (m *RoomManager) stopTimerLocked(id string) {
	if timer, ok := m.timers[id]; ok {
		timer.Stop()
		delete(m.timers, id)
	}
}

func (m *RoomManager) scheduleExpirationLocked(id string, duration time.Duration) {
	m.stopTimerLocked(id)
	m.timers[id] = time.AfterFunc(duration, func() {
		m.expireRoom(id)
	})
}

func snapshotMessage(snapshot RoomSnapshot) []byte {
	msg := OutgoingMessage{
		Type:    "room_state",
		Content: snapshot.Content,
		Mode:    snapshot.Mode,
		Cursors: snapshot.Cursors,
	}
	if !snapshot.ExpiresAt.IsZero() {
		msg.ExpiresAt = snapshot.ExpiresAt.Format(time.RFC3339)
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return nil
	}
	return data
}

func (r *Room) UpdateCursor(clientID string, start, end int) {
	if clientID == "" {
		return
	}
	if start < 0 {
		start = 0
	}
	if end < 0 {
		end = start
	}

	r.mu.Lock()
	r.cursors[clientID] = CursorState{Start: start, End: end}
	r.mu.Unlock()

	r.broadcast(OutgoingMessage{
		Type:        "cursor",
		ClientID:    clientID,
		CursorStart: start,
		CursorEnd:   end,
	})
}

func (r *Room) copyCursorsLocked() map[string]CursorState {
	if len(r.cursors) == 0 {
		return nil
	}
	copied := make(map[string]CursorState, len(r.cursors))
	for id, cur := range r.cursors {
		copied[id] = cur
	}
	return copied
}
