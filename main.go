package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
	manager := NewRoomManager()

	http.Handle("/", http.FileServer(http.Dir("./static")))
	http.HandleFunc("/api/join", func(w http.ResponseWriter, r *http.Request) {
		handleJoinRoom(manager, w, r)
	})
	http.HandleFunc("/ws", manager.HandleWebSocket)

	addr := ":" + defaultPort()
	log.Printf("Listening on %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func defaultPort() string {
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		if _, err := strconv.Atoi(port); err == nil {
			return port
		}
		log.Printf("Invalid PORT value %q, falling back to 8080", port)
	}
	return "8080"
}

type joinRequest struct {
	RoomID          string `json:"roomId"`
	Password        string `json:"password"`
	Mode            string `json:"mode"`
	DurationSeconds int    `json:"durationSeconds"`
}

type joinResponse struct {
	RoomID    string                 `json:"roomId"`
	Mode      string                 `json:"mode"`
	ExpiresAt string                 `json:"expiresAt,omitempty"`
	Content   string                 `json:"content"`
	Created   bool                   `json:"created"`
	Cursors   map[string]CursorState `json:"cursors,omitempty"`
}

func handleJoinRoom(manager *RoomManager, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	var req joinRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request payload"})
		return
	}

	roomID := strings.TrimSpace(req.RoomID)
	password := strings.TrimSpace(req.Password)

	mode, err := ParseRoomMode(req.Mode)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var duration time.Duration
	if mode == ModeCountdown {
		if req.DurationSeconds <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "durationSeconds must be > 0 for countdown mode"})
			return
		}
		duration = time.Duration(req.DurationSeconds) * time.Second
	}

	room, created, err := manager.JoinOrCreateRoom(roomID, password, mode, duration)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	snapshot := room.Snapshot()
	resp := joinResponse{
		RoomID:  roomID,
		Mode:    string(snapshot.Mode),
		Content: snapshot.Content,
		Created: created,
		Cursors: snapshot.Cursors,
	}
	if !snapshot.ExpiresAt.IsZero() {
		resp.ExpiresAt = snapshot.ExpiresAt.Format(time.RFC3339)
	}

	writeJSON(w, http.StatusOK, resp)
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("writeJSON error: %v", err)
	}
}
