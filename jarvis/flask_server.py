import os
import time
import threading
import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

# Configuration via environment variables
# Example:
#   export EXPERT_BASE_URL="https://bentlee-recriminatory-theresa.ngrok-free.dev"
#   export ROOM_ID="your-room-id"
EXPERT_BASE_URL = os.environ.get('EXPERT_BASE_URL', 'http://localhost:3001')
DEFAULT_ROOM_ID = os.environ.get('ROOM_ID', 'demo')
POLL_INTERVAL_SEC = float(os.environ.get('POLL_INTERVAL_SEC', '1.0'))

_last_by_room = {}  # room_id -> latest payload from Node (/api/hand-landmarks)

def fetch_landmarks_once(server_base: str, room_id: str):
    """Fetch once from Node server endpoint and return parsed JSON (or None)."""
    try:
        # Prefer API route to avoid collisions with static '/expert' path
        url = f"{server_base.rstrip('/')}/api/hand-landmarks"
        resp = requests.get(url, params={'roomId': room_id}, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        # Cache latest by room
        try:
            rid = data.get('roomId') or room_id
            _last_by_room[rid] = data.get('data')
        except Exception:
            pass
        return data
    except Exception as e:
        print(f"[Flask] Fetch error: {e}")
        return None


def poll_loop(server_base: str, room_id: str, stop_event: threading.Event):
    """Background loop to poll and print landmarks periodically."""
    print(f"[Flask] Starting poll loop → base={server_base}, roomId={room_id}")
    while not stop_event.is_set():
        data = fetch_landmarks_once(server_base, room_id)
        if data is not None:
            # For now, just print it
            print(f"[Flask] Landmarks ({room_id}): {data}")
        time.sleep(POLL_INTERVAL_SEC)
    print("[Flask] Poll loop stopped.")


poll_thread = None
poll_stop_event = threading.Event()


@app.route('/poll/start', methods=['POST'])
def start_poll():
    """Start background polling. Body/params: server_base, room_id"""
    global poll_thread, poll_stop_event
    if poll_thread and poll_thread.is_alive():
        return jsonify({'status': 'already_running'})

    server_base = request.json.get('server_base') if request.is_json else request.args.get('server_base')
    room_id = request.json.get('room_id') if request.is_json else request.args.get('room_id')
    server_base = server_base or EXPERT_BASE_URL
    room_id = room_id or DEFAULT_ROOM_ID

    poll_stop_event = threading.Event()
    poll_thread = threading.Thread(target=poll_loop, args=(server_base, room_id, poll_stop_event), daemon=True)
    poll_thread.start()
    return jsonify({'status': 'started', 'server_base': server_base, 'room_id': room_id})


@app.route('/poll/stop', methods=['POST'])
def stop_poll():
    """Stop background polling."""
    global poll_thread, poll_stop_event
    if poll_thread and poll_thread.is_alive():
        poll_stop_event.set()
        poll_thread.join(timeout=2.0)
        return jsonify({'status': 'stopped'})
    return jsonify({'status': 'not_running'})


@app.route('/poll/once', methods=['GET'])
def poll_once():
    """Fetch once and return the JSON (also prints)."""
    server_base = request.args.get('server_base', EXPERT_BASE_URL)
    room_id = request.args.get('room_id', DEFAULT_ROOM_ID)
    data = fetch_landmarks_once(server_base, room_id)
    print(f"[Flask] Landmarks (once) room={room_id}: {data}")
    return jsonify({'server_base': server_base, 'room_id': room_id, 'data': data})


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True})

@app.route('/landmarks/latest', methods=['GET'])
def latest():
    """Return the last cached skeleton payload for a room, if any."""
    room_id = request.args.get('room_id', DEFAULT_ROOM_ID)
    # The cached structure is whatever Node returned at `data`:
    # { skeleton: { landmarks:[{x,y,z}], handedness?, clear?, ts? }, updatedAt, senderId }
    payload = _last_by_room.get(room_id)
    return jsonify({'room_id': room_id, 'data': payload})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '5001'))
    app.run(host='0.0.0.0', port=port)


