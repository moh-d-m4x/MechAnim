# MechAnim: Character Motion Designer

![MechAnim Dashboard](https://raw.githubusercontent.com/moh-d-m4x/MechAnim/refs/heads/main/ref/MechAnim_Dashboard.PNG)

**MechAnim** is a powerful web-based tool for designing, simulating, and optimizing mechanical linkages and character motion. It combines interactive 2D physics simulation with genetic algorithms to help users create complex mechanisms that follow specific motion paths.

## 🚀 Features

### 🛠️ Interactive Mechanism Design
- **Multiple Mechanism Types**: Support for 4-bar, 5-bar, Piston, and Scotch Yoke mechanisms.
- **Drag-and-Drop Editor**: Intuitively adjust link lengths, anchor points, and joint positions directly on the canvas.
- **Real-time Simulation**: Visualize motion instantly as you modify the design.
- **Parametric Controls**: Fine-tune specific values like crank length, ground distance, and speed ratios.

![Draw Mode](https://raw.githubusercontent.com/moh-d-m4x/MechAnim/refs/heads/main/ref/Draw_Mode.PNG)

### 🧬 AI-Powered Optimization
- **Path Drawing**: Draw a desired motion path directly on the canvas.
- **Genetic Algorithm**: Automatically evolve mechanism configurations to match your drawn path.
- **Smart Generation**: Uses Monte Carlo search and evolutionary strategies to find the best fit.
- **Shape Preservation**: Optimization algorithms respect the "DNA" of mechanism types, preserving speed ratios and key characteristics while fitting the curve.

### 📹 Video Motion Tracking (BootsTAPIR)
- **Import Video**: Upload reference footage of motion.
- **TAPIR Point Tracking**: Uses Google DeepMind's BootsTAPIR model for state-of-the-art point tracking.
- **GPU Accelerated**: Leverages NVIDIA CUDA for fast inference on supported GPUs.
- **Path Extraction**: Convert video motion into a target path for mechanism optimization.
- **Manual Correction**: Fine-tune tracking results frame-by-frame for perfect accuracy.

![Tracking Modal](https://raw.githubusercontent.com/moh-d-m4x/MechAnim/refs/heads/main/ref/Tracking_Modal_1.PNG)
![Tracking Modal](https://raw.githubusercontent.com/moh-d-m4x/MechAnim/refs/heads/main/ref/Tracking_Modal_2.PNG)

### 📤 Export & Integration
- **SVG Export**: Export your mechanism and path as scalable vector graphics.
- **DXF Export**: Generate CAD-ready files for laser cutting or 3D modeling.
- **Presets**: Save and load your favorite mechanism configurations.

## 📦 Getting Started

### Prerequisites
- **Node.js**: v16 or higher
- **Python**: v3.8 or higher
- **NVIDIA GPU** (recommended): For TAPIR acceleration with CUDA 11.8+
- **Miniconda** (Recommended for Python environment management)

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/yourusername/mechanim.git
    cd mechanim
    ```

2.  **Install Frontend Dependencies**
    ```bash
    npm install
    ```

3.  **Setup Backend**
    ```bash
    cd backend
    python -m venv venv
    # Windows
    venv\Scripts\activate
    # Linux/Mac
    # source venv/bin/activate
    pip install -r requirements.txt
    ```

4.  **Install PyTorch (for TAPIR tracking)**
    ```bash
    # With CUDA support (recommended for GPU)
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118
    
    # Or CPU only (slower)
    pip install torch torchvision
    ```

5.  **Download TAPIR Model** (automatic on first use)
    - The BootsTAPIR checkpoint (~500MB) downloads automatically when you first enable Auto tracking.
    - Or manually: Download from [Google Storage](https://storage.googleapis.com/dm-tapnet/bootstap/causal_bootstapir_checkpoint.pt) to `backend/models/`

### Running the Application

**Quick Start (Windows):**
```bash
run_browser.bat
```

**Manual Start:**

1.  **Start the Backend Server**
    ```bash
    # In the backend directory
    python server.py
    ```
    The API will be available at `http://localhost:8000`.

2.  **Start the Frontend**
    ```bash
    # In the root directory
    npm run dev
    ```
    Open `http://localhost:3000` in your browser.

## 📖 Usage Guide

### Designing a Mechanism
1.  **Select a Mechanism**: Choose from presets like "Crank-Rocker" or "Piston Pusher" in the left sidebar.
2.  **Modify**: Click "Draw Mode" to toggle interaction. Drag joints to resize or anchors to move.
3.  **Adjust**: Use the sliders in the sidebar for precise control over lengths and angles.

### Optimizing for a Path
1.  **Draw**: Enable "Draw Mode" and sketch a loop or curve on the canvas.
2.  **Select**: Click on the mechanism you want to fit to the path.
3.  **Optimize**: Click the "Optimize" button. The AI will iterate through variations to match your drawing.
4.  **Refine**: Adjust the optimization duration or seed mechanism for better results.

### Using Video Tracking
1.  **Open Tracker**: Click the "Track Video" button in the controls.
2.  **Upload**: Select a video file containing the motion you want to replicate.
3.  **Enable Auto Mode**: Toggle "Auto" to use TAPIR-based tracking.
4.  **Download Model**: First time only - download the BootsTAPIR model when prompted.
5.  **Initialize**: Draw a rectangle around the point to track on the first frame.
6.  **Track**: Click "Run Tracking". TAPIR tracks the point through all frames.
7.  **Transfer**: Click "Use Path" to send the tracked motion to the main editor for optimization.

## 🛠️ Technology Stack

- **Frontend**: React 19, TypeScript, Vite, TailwindCSS, Lucide React
- **Backend**: Python, FastAPI, Uvicorn
- **Point Tracking**: BootsTAPIR (PyTorch) - Google DeepMind's state-of-the-art tracker
- **Computer Vision**: OpenCV (fallback optical flow)
- **Simulation**: Custom kinematic solvers

## 🏭 Production Distribution

For distributing the app without requiring users to install PyTorch:

1. Export TAPIR model to ONNX format
2. Bundle ONNX Runtime (~50-180MB) instead of PyTorch (~2.5GB)
3. Users only need the lightweight ONNX runtime

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
