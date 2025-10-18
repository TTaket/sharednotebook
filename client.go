package main

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

type Client struct {
	room      *Room
	conn      *websocket.Conn
	send      chan []byte
	closeOnce sync.Once
}

type inboundMessage struct {
	Type    string `json:"type"`
	Content string `json:"content"`
}

func NewClient(room *Room, conn *websocket.Conn) *Client {
	return &Client{
		room: room,
		conn: conn,
		send: make(chan []byte, 16),
	}
}

func (c *Client) start() {
	go c.writePump()
	c.readPump()
}

func (c *Client) readPump() {
	defer c.close()

	c.conn.SetReadLimit(64 * 1024)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg inboundMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "content":
			c.room.UpdateContent(msg.Content)
		default:
			// ignore unknown message types
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if msg == nil {
				continue
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) enqueue(message []byte) {
	if message == nil {
		return
	}
	defer func() {
		if recover() != nil {
			// channel closed; nothing else to do
		}
	}()
	select {
	case c.send <- message:
	default:
		go c.close()
	}
}

func (c *Client) close() {
	c.closeOnce.Do(func() {
		c.room.RemoveClient(c)
		close(c.send)
		_ = c.conn.Close()
	})
}
