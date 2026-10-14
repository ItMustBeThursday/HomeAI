"""Read-only native PyTorch/HIP probe. Does not download or modify models."""
import json
import platform
report = {"python": platform.python_version(), "platform": platform.system(), "gpuReady": False}
try:
    import torch
    report.update(torch=torch.__version__, hip=getattr(torch.version, "hip", None), cudaAvailable=torch.cuda.is_available())
    if report["hip"] and report["cudaAvailable"]:
        device = torch.device("cuda:0")
        tensor = torch.ones((16, 16), device=device)
        report.update(device=torch.cuda.get_device_name(0), vramBytes=torch.cuda.get_device_properties(0).total_memory,
                      gpuReady=bool(torch.isfinite(tensor @ tensor).all().item()))
except Exception as exc:
    report["error"] = str(exc)[:400]
print(json.dumps(report))
