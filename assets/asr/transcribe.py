#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把音频转成文字（离线，CPU），给「看视频」的声音通道用。

这是随插件附带的一份通用版本：不写死任何本机路径。
想换模型 / 换 ffmpeg，用环境变量或 --model：
    BUBBLE_WHISPER_MODEL  模型目录，或 small/base/medium 这类名字（会给 faster-whisper 自己下）
    BUBBLE_FFMPEG         ffmpeg 可执行文件（不给就从 PATH 找）

输出格式（插件按这个解析，别改）：
    FILE=<路径>
    LANG=zh DUR=12.34s
    TEXT=<识别出的文字>
    -

用法：python transcribe.py <音频> [<音频2> ...]
"""
import os
import shutil
import subprocess
import sys

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get('BUBBLE_WHISPER_MODEL', '').strip()
FFMPEG = os.environ.get('BUBBLE_FFMPEG', '').strip() or shutil.which('ffmpeg') or 'ffmpeg'


def load_audio(path, sr=16000):
    cmd = [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error',
           '-i', path, '-f', 'f32le', '-acodec', 'pcm_f32le',
           '-ac', '1', '-ar', str(sr), '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def build_model():
    if MODEL == '':
        return WhisperModel('small', device='cpu', compute_type='int8')
    if os.path.isdir(MODEL):
        return WhisperModel(MODEL, device='cpu', compute_type='int8', local_files_only=True)
    return WhisperModel(MODEL, device='cpu', compute_type='int8')


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    args = sys.argv[1:]
    if args and args[0] == '--model':
        global MODEL
        MODEL = args[1]
        args = args[2:]
    if not args:
        print('用法：python transcribe.py <音频> [...]')
        return 2

    print('加载 whisper ...', flush=True)
    model = build_model()
    for path in args:
        try:
            audio = load_audio(path)
        except Exception as e:  # noqa: BLE001
            print('FILE=%s\nDECODE_ERR=%s\n-' % (path, e))
            continue
        segs, info = model.transcribe(audio, language='zh', beam_size=5, vad_filter=True)
        text = ''.join(s.text for s in segs).strip()
        print('FILE=%s' % path)
        print('LANG=%s DUR=%.2fs' % (info.language, info.duration))
        print('TEXT=%s' % (text if text else '(空)'))
        print('-')
    return 0


if __name__ == '__main__':
    sys.exit(main())
