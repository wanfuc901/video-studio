import importlib.util
import io
import threading
import unittest
import wave
from pathlib import Path

spec = importlib.util.spec_from_file_location('local_ai', Path(__file__).parents[1] / 'tools/local-ai/server.py')
local_ai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_ai)


def multipart():
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000); out.writeframes(b'\0\0' * 160)
    body = b'--test\r\nContent-Disposition: form-data; name="model"\r\n\r\ntiny\r\n'
    body += b'--test\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n' + audio.getvalue() + b'\r\n--test--\r\n'
    return body


class Engine:
    device = 'cpu'
    compute_type = 'int8'
    lock = threading.Lock()

    def transcribe(self, fields, audio):
        return {'words': [{'word': 'test', 'start': 0, 'end': .01}]}


class LocalAITest(unittest.TestCase):
    def handler(self, headers=None, path='/health', body=b''):
        engine = Engine()
        cls = local_ai.make_handler(engine, 'unit-test-code', {local_ai.SITE_ORIGIN})
        handler = cls.__new__(cls)
        handler.headers = headers or {}
        handler.path = path
        handler.rfile = io.BytesIO(body)
        handler.reply = lambda status, payload=None: setattr(handler, 'result', (status, payload))
        return handler

    def test_audio_parser_and_word_response(self):
        body = multipart()
        fields, audio = local_ai.parse_audio('multipart/form-data; boundary=test', body)
        self.assertEqual(fields['model'], 'tiny')
        self.assertTrue(audio.startswith(b'RIFF'))
        handler = self.handler({'Authorization': 'Bearer unit-test-code', 'Origin': local_ai.SITE_ORIGIN,
                                'Content-Length': str(len(body)), 'Content-Type': 'multipart/form-data; boundary=test'},
                               '/v1/audio/transcriptions', body)
        handler.do_POST()
        self.assertEqual(handler.result[0], 200)
        self.assertEqual(handler.result[1]['words'][0]['word'], 'test')

    def test_auth_and_origin_are_required(self):
        for headers in [{}, {'Authorization': 'Bearer wrong'},
                        {'Authorization': 'Bearer unit-test-code', 'Origin': 'https://unrelated.example'}]:
            handler = self.handler(headers)
            handler.do_GET()
            self.assertEqual(handler.result[0], 403)

    def test_oversized_upload_is_rejected_before_read(self):
        handler = self.handler({'Authorization': 'Bearer unit-test-code', 'Content-Length': str(local_ai.MAX_BODY + 1)}, '/v1/audio/transcriptions')
        handler.do_POST()
        self.assertEqual(handler.result[0], 413)

    def test_health_reports_engine(self):
        handler = self.handler({'Authorization': 'Bearer unit-test-code'})
        handler.do_GET()
        self.assertEqual(handler.result[1]['service'], 'video-studio-local')

    def test_cors_blocks_other_sites(self):
        handler = self.handler({'Origin': 'https://unrelated.example'})
        handler.do_OPTIONS()
        self.assertEqual(handler.result[0], 403)


if __name__ == '__main__':
    unittest.main()
