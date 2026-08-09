# Krono Fantasy Party Server

Server WebSocket/HTTP pensato per Fly.io per gestire:

- chat create dai client
- party condivisi tra computer diversi
- relay degli eventi di esplorazione del party
- endpoint `/health` per health check e monitoraggio

## Avvio locale

```bash
npm install
npm start
```

Server HTTP: `http://localhost:8080/`

WebSocket: `ws://localhost:8080`

## Variabili ambiente

- `PORT`: porta del server, default `8080`
- `HOST`: host bind, default `0.0.0.0`
- `ALLOWED_ORIGINS`: lista separata da virgole di origin consentiti
- `HEARTBEAT_MS`: ping/pong heartbeat, default `30000`
- `MAX_MESSAGE_SIZE`: dimensione max payload JSON, default `16384`
- `MAX_CHAT_LENGTH`: lunghezza max messaggio chat, default `400`

Esempio:

```bash
ALLOWED_ORIGINS=https://kronofantasy.net,https://www.kronofantasy.net,http://localhost:5173
```

## Protocollo messaggi

Tutti i payload client devono essere JSON:

```json
{
	"type": "identify",
	"requestId": "abc-1",
	"payload": {
		"name": "Nero",
		"playerId": "user_123",
		"saveId": "slot_1"
	}
}
```

### Eventi principali

- `identify`: registra nome, save id, avatar e metadata del client
- `chat.list`: ritorna le stanze pubbliche
- `chat.create`: crea una stanza custom
- `chat.join`: entra in una stanza
- `chat.leave`: esce da una stanza
- `chat.message`: invia un messaggio nella stanza
- `party.list`: ritorna i party aperti
- `party.create`: crea un party e una room privata associata
- `party.join`: entra tramite `partyId` oppure `code`
- `party.leave`: esce dal party
- `party.member_state`: aggiorna stato locale del membro (`ready`, `hp`, `level`, `mapId`, `row`, `col`, `status`, `meta`)
- `party.state`: il leader aggiorna lo stato condiviso del party
- `party.explore`: relay evento di esplorazione verso tutto il party
- `party.action`: relay di azioni generiche coop
- `party.kick`: espelle un membro, solo leader
- `party.open`: apre/chiude il party a nuovi ingressi, solo leader

### Esempi rapidi

Creare un party:

```json
{
	"type": "party.create",
	"payload": {
		"name": "Team Ashbound",
		"member": {
			"level": 42,
			"hp": 1300,
			"mapId": "map_3",
			"row": 12,
			"col": 8,
			"status": "idle"
		}
	}
}
```

Sincronizzare la posizione del leader:

```json
{
	"type": "party.state",
	"payload": {
		"state": {
			"status": "exploring",
			"mapId": "map_3",
			"row": 12,
			"col": 8,
			"encounter": null
		}
	}
}
```

Inviare un evento di esplorazione coop:

```json
{
	"type": "party.explore",
	"payload": {
		"event": "encounter_started",
		"data": {
			"mapId": "map_3",
			"row": 12,
			"col": 8,
			"monsters": ["map_3_lupo_cenere", "map_3_strega_lava"]
		}
	}
}
```

Chat in una stanza:

```json
{
	"type": "chat.message",
	"payload": {
		"roomId": "party:party_ab12cd34ef56",
		"text": "Ho trovato un gruppo di mostri a est"
	}
}
```

## Deploy Fly.io

Questa cartella puo essere deployata direttamente come app Node. Procedura tipica:

```bash
fly launch
fly deploy
```

Imposta almeno `ALLOWED_ORIGINS` nei secrets o nelle variabili runtime.

Il server espone `GET /health`, utile per health checks Fly.
