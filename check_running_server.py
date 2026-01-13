
import requests
import base64
import json
import numpy as np
import cv2

def create_dummy_video():
    # Create a 1-frame black video (mp4)
    # Using opencv to write a small video
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out_path = 'dummy.mp4'
    out = cv2.VideoWriter(out_path, fourcc, 1, (100, 100))
    out.write(frame)
    out.release()
    
    with open(out_path, 'rb') as f:
        video_data = f.read()
    return base64.b64encode(video_data).decode('utf-8')

def check_server():
    print("Checking running server at http://localhost:8000...")
    
    try:
        video_b64 = create_dummy_video()
        
        payload = {
            "video_data": video_b64,
            "init_point": {"x": 50, "y": 50, "frame": 0},
            "video_format": "mp4",
            "smooth": False,
            "tracking_method": "euclidean"
        }
        
        response = requests.post("http://localhost:8000/track", json=payload)
        
        if response.status_code != 200:
            print(f"Server returned error: {response.status_code}")
            print(response.text)
            return

        data = response.json()
        if not data.get('success'):
            print(f"Tracking failed: {data.get('error')}")
            return
            
        path = data.get('path', [])
        if not path:
            print("No path returned")
            return
            
        first_point = path[0]
        print(f"Received point keys: {list(first_point.keys())}")
        
        if 'visible' in first_point:
            print("PASS: 'visible' field is present in response.")
            print(f"Value: {first_point['visible']}")
        else:
            print("FAIL: 'visible' field is MISSING.")
            print("The server is likely running the OLD version.")

    except requests.exceptions.ConnectionError:
        print("FAIL: Could not connect to http://localhost:8000. Server not running?")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_server()
