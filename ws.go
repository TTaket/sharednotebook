package main

import (
	"log"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Allow all origins; adjust as needed for stricter deployments.
		return true
	},
}

func (m *RoomManager) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	roomID := strings.TrimSpace(r.URL.Query().Get("roomId"))
	password := strings.TrimSpace(r.URL.Query().Get("password"))

	if roomID == "" {
		http.Error(w, "roomId is required", http.StatusBadRequest)
		return
	}

	room, ok := m.getRoom(roomID)
	if !ok {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}

	if !room.CheckPassword(password) {
		http.Error(w, "invalid password", http.StatusForbidden)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}

	client := NewClient(room, conn)
	room.AddClient(client)
	client.start()
}
