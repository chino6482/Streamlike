#!/usr/bin/env python3
"""
Tracker facial ligero para Auto-Reframe 9:16 en StreamLike.
Muestrea el segmento [start_time, end_time] a ~3 FPS con OpenCV, detecta rostros
mediante MediaPipe Face Detection, selecciona el hablante principal (mayor área
o más cercano al centro en tamaños similares), suaviza con EMA y emite JSON compacto.
"""

import argparse
import json
import os
import sys

os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")


def clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))


def pick_primary_face_x(detections, frame_width: int, frame_height: int) -> float | None:
    if not detections:
        return None

    candidates = []
    for det in detections:
        loc = getattr(det, "location_data", None)
        if loc is None:
            continue
        bbox = getattr(loc, "relative_bounding_box", None)
        if bbox is None:
            continue
        w = max(0.0, float(bbox.width))
        h = max(0.0, float(bbox.height))
        area = w * h
        if area <= 0.0:
            continue
        cx = clamp(float(bbox.xmin) + w / 2.0, 0.0, 1.0)
        candidates.append((area, cx))

    if not candidates:
        return None

    max_area = max(c[0] for c in candidates)
    # Si hay varios rostros de tamaño similar (>=75% del mayor), prioriza el más centrado
    similar_sized = [c for c in candidates if c[0] >= max_area * 0.75]
    chosen = min(similar_sized, key=lambda c: abs(c[1] - 0.5))
    return chosen[1]


def simplify_keyframes(keyframes: list[dict], max_points: int = 36) -> list[dict]:
    if len(keyframes) <= 2:
        return keyframes

    filtered = [keyframes[0]]
    for point in keyframes[1:-1]:
        prev = filtered[-1]
        if abs(point["x"] - prev["x"]) >= 0.015 or (point["t"] - prev["t"]) >= 1.5:
            filtered.append(point)
    if filtered[-1]["t"] != keyframes[-1]["t"]:
        filtered.append(keyframes[-1])

    if len(filtered) <= max_points:
        return filtered

    # Submuestreo uniforme conservando inicio y fin
    step = (len(filtered) - 1) / (max_points - 1)
    sampled = [filtered[round(i * step)] for i in range(max_points)]
    sampled[0] = filtered[0]
    sampled[-1] = filtered[-1]
    return sampled


def track_faces(
    video_path: str,
    start_time: float,
    end_time: float,
    sample_fps: float = 3.0,
    alpha: float = 0.32,
) -> dict:
    try:
        import cv2
        import mediapipe as mp
    except Exception as exc:
        sys.stderr.write(f"Import error: {exc}\n")
        return {"hasFaces": False, "keyframes": []}

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return {"hasFaces": False, "keyframes": []}

    try:
        src_fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        if src_fps <= 0.0:
            src_fps = 30.0
        total_frames = float(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0)
        max_duration = (total_frames / src_fps) if total_frames > 0 else end_time

        seg_start = max(0.0, start_time)
        seg_end = min(max_duration, end_time) if max_duration > 0 else end_time
        if seg_end <= seg_start:
            seg_end = seg_start + 0.5

        step_frames = max(1, int(round(src_fps / max(0.5, sample_fps))))

        cap.set(cv2.CAP_PROP_POS_MSEC, seg_start * 1000.0)

        mp_face = mp.solutions.face_detection
        sampled_frames = 0
        detected_frames = 0
        ema_x: float | None = None
        keyframes: list[dict] = []

        with mp_face.FaceDetection(
            model_selection=1, min_detection_confidence=0.5
        ) as detector:
            frame_idx = 0
            while True:
                current_pos_ms = float(cap.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
                current_sec = current_pos_ms / 1000.0
                if frame_idx > 0 and current_sec > seg_end + 0.05:
                    break

                if frame_idx % step_frames == 0:
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        break
                    sampled_frames += 1

                    h, w = frame.shape[:2]
                    if w > 480:
                        scale = 480.0 / float(w)
                        frame = cv2.resize(
                            frame,
                            (480, max(1, int(round(h * scale)))),
                            interpolation=cv2.INTER_AREA,
                        )

                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    result = detector.process(rgb)
                    raw_x = pick_primary_face_x(
                        getattr(result, "detections", None), frame.shape[1], frame.shape[0]
                    )

                    if raw_x is not None:
                        detected_frames += 1
                        if ema_x is None:
                            ema_x = raw_x
                        else:
                            ema_x = alpha * raw_x + (1.0 - alpha) * ema_x
                        rel_t = max(0.0, round(current_sec - seg_start, 2))
                        keyframes.append({"t": rel_t, "x": round(clamp(ema_x, 0.0, 1.0), 4)})
                else:
                    if not cap.grab():
                        break

                frame_idx += 1

        has_faces = sampled_frames > 0 and (detected_frames / sampled_frames) > 0.30
        if not has_faces:
            return {"hasFaces": False, "keyframes": []}

        return {
            "hasFaces": True,
            "keyframes": simplify_keyframes(keyframes),
        }
    finally:
        cap.release()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Dynamic face tracking for vertical 9:16 auto-reframe."
    )
    parser.add_argument("video_path", help="Path to source video file")
    parser.add_argument("start_time", type=float, help="Segment start time in seconds")
    parser.add_argument("end_time", type=float, help="Segment end time in seconds")
    parser.add_argument("--sample-fps", type=float, default=3.0)
    parser.add_argument("--alpha", type=float, default=0.32)
    args = parser.parse_args()

    output = track_faces(
        args.video_path,
        args.start_time,
        args.end_time,
        sample_fps=args.sample_fps,
        alpha=args.alpha,
    )
    sys.stdout.write(json.dumps(output, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
