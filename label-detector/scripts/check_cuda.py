from __future__ import annotations

try:
    import torch
except ImportError:
    print("PyTorch is not installed yet.")
    raise SystemExit(1)


def main() -> None:
    print(f"torch version: {torch.__version__}")
    print(f"cuda available: {torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"gpu count: {torch.cuda.device_count()}")
        print(f"current gpu: {torch.cuda.get_device_name(0)}")
    else:
        print("CUDA is not available. Install a CUDA-enabled PyTorch build before training.")


if __name__ == "__main__":
    main()
