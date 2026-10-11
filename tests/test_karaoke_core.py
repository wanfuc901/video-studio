import importlib.util
import io
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

TOOLS = Path(__file__).parents[1] / 'tools/local-ai'
sys.path.insert(0, str(TOOLS))
import ctc_align  # noqa: E402
import karaoke_pipeline  # noqa: E402
import vocal_analysis as va  # noqa: E402

spec = importlib.util.spec_from_file_location('local_ai_server', TOOLS / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

VOCAB = {'<pad>': 0, '|': 1, 'a': 2, 'b': 3, 'c': 4, 'ư': 5, 'ờ': 6}


def emissions(plan, vocab_size=len(VOCAB)):
    """plan: list of (token_id, frames); the planned token gets 0.9, the rest share 0.1."""
    rows = []
    for token, count in plan:
        row = np.full(vocab_size, np.log(0.1 / (vocab_size - 1)))
        row[token] = np.log(0.9)
        rows.extend([row] * count)
    return np.array(rows)


class CtcAlignTest(unittest.TestCase):
    def test_words_land_on_their_characters(self):
        e = emissions([(0, 5), (2, 5), (3, 5), (1, 3), (0, 8), (4, 5), (0, 5)])
        spans = ctc_align.align_words(e, ['AB!', 'c'], VOCAB, blank=0, separator=1)
        self.assertEqual((spans[0].start_frame, spans[0].end_frame), (5, 15))
        self.assertEqual((spans[1].start_frame, spans[1].end_frame), (26, 31))
        self.assertGreater(spans[0].score, 0.8)

    def test_repeated_characters_need_a_blank_and_unknown_words_return_none(self):
        e = emissions([(0, 2), (2, 3), (0, 2), (2, 3), (0, 2)])
        spans = ctc_align.align_words(e, ['aa', '123'], VOCAB, blank=0)
        self.assertEqual((spans[0].start_frame, spans[0].end_frame), (2, 10))
        self.assertIsNone(spans[1])

    def test_vietnamese_is_matched_in_nfc_and_too_short_audio_is_rejected(self):
        self.assertEqual(ctc_align.word_token_ids('Ờ', VOCAB), [VOCAB['ờ']])  # decomposed input
        self.assertEqual(ctc_align.word_token_ids('Ờ', VOCAB), [VOCAB['ờ']])
        with self.assertRaises(ValueError):
            ctc_align.align_words(emissions([(2, 1)]), ['abc'], VOCAB, blank=0)


class VocalAnalysisTest(unittest.TestCase):
    def test_frame_level_of_a_sine(self):
        t = np.arange(16000) / 16000
        levels = va.frame_db(0.5 * np.sin(2 * np.pi * 220 * t))
        self.assertEqual(levels.size, 100)
        self.assertAlmostEqual(float(np.median(levels)), 20 * math.log10(0.5 / math.sqrt(2)), delta=0.5)

    def test_held_note_extends_until_voice_stops_and_ignores_short_dips(self):
        dry = np.full(300, -70.0)
        dry[0:20] = -10
        dry[20:120] = -15
        dry[60:64] = -50  # 40 ms breath dip inside the held note
        self.assertEqual(va.extend_sustain(0, 20, 300, dry, None, -70), 120)
        voiced = np.ones(300, dtype=bool)
        voiced[80:] = False
        self.assertEqual(va.extend_sustain(0, 20, 300, dry, voiced, -70), 80)
        self.assertEqual(va.extend_sustain(0, 20, 50, dry, None, -70), 50)

    def test_echo_tail_outlasts_the_voice(self):
        wet = np.full(400, -75.0)
        wet[0:100] = -12
        wet[100:220] = np.linspace(-20, -46, 120)
        self.assertGreater(va.echo_end(100, 400, wet, -12, -75), 200)
        self.assertEqual(va.echo_end(100, 150, wet, -12, -75), 150)

    def test_sustain_never_reaches_the_next_word_and_marks_real_held_notes(self):
        dry = np.full(500, -70.0)
        dry[0:300] = -12
        words = [va.WordTiming('yêu', 0.0, 0.3), va.WordTiming('em', 2.0, 2.4)]
        va.apply_sustain(words, dry, None, 5.0)
        self.assertAlmostEqual(words[0].end, 2.0, places=3)
        self.assertGreaterEqual(words[0].sustain, va.MIN_SUSTAIN_SECONDS)

    def test_ctc_starts_move_back_to_the_vocal_onset_or_compensate_the_lag(self):
        # CTC spikes measured at 0.322 / 0.664 / 0.885 s; real onsets at 0.23 / 0.52 s; "Hà" has no onset.
        words = [va.WordTiming('Em', 0.322, 0.362), va.WordTiming('ơi', 0.664, 0.704), va.WordTiming('Hà', 0.885, 1.086)]
        va.snap_onsets(words, np.array([0.23, 0.52, 1.19]))
        self.assertEqual([round(w.start, 3) for w in words], [0.23, 0.52, round(0.885 - va.CTC_LAG_SECONDS, 3)])
        self.assertLessEqual(words[0].end, words[1].start)

    def test_onsets_never_cross_the_previous_word(self):
        words = [va.WordTiming('a', 1.0, 1.2), va.WordTiming('b', 1.1, 1.4)]
        va.snap_onsets(words, np.array([0.95, 1.0]))
        self.assertGreaterEqual(words[1].start, words[0].start + va.MIN_WORD_SECONDS)

    def test_double_time_beats_fold_to_the_stronger_phase(self):
        beats = np.arange(0.3, 10, 0.3)
        strong = {round(b, 1) for b in np.arange(0.6, 10, 0.6)}
        tempo, folded = va.fold_tempo(200.0, beats, lambda times: sum(round(t, 1) in strong for t in times) / max(1, len(times)))
        self.assertEqual(tempo, 100.0)
        self.assertTrue(all(round(t, 1) in strong for t in folded))
        self.assertEqual(va.fold_tempo(50.0, np.array([0.0, 1.2, 2.4]), lambda t: 0)[0], 100.0)

    def test_line_echo_is_capped_by_next_line(self):
        wet = np.full(1000, -70.0)
        wet[0:600] = -10
        lines = [[va.WordTiming('a', 0.0, 1.0)], [va.WordTiming('b', 3.0, 4.0)]]
        ends = va.line_echo_ends(lines, wet, 10.0)
        self.assertEqual(ends[0], 3.0)


class PipelineHelpersTest(unittest.TestCase):
    def test_language_guess_from_lyrics(self):
        self.assertEqual(karaoke_pipeline.guess_language('Em ơi Hà Nội phố'), 'vi')
        self.assertEqual(karaoke_pipeline.guess_language('Hello darkness my old friend'), 'en')
        self.assertEqual(karaoke_pipeline.guess_language('사랑해'), 'ko')

    def test_results_are_json_safe_even_with_numpy_scalars(self):
        word = va.WordTiming('lan', np.float32(9.9), np.float64(12.07), np.float32(0.8), np.bool_(False), np.float64(1.92))
        line = karaoke_pipeline.serialize_line('Ta còn em mùi hoàng lan', [word], np.float64(12.34))
        payload = json.loads(json.dumps(line))
        self.assertEqual(payload['words'][0], {'word': 'lan', 'start': 9.9, 'end': 12.07, 'score': 0.8, 'estimated': False, 'sustain': 1.92})
        self.assertEqual(payload['echoEnd'], 12.34)

    def test_missing_words_share_the_gap(self):
        words = [va.WordTiming('a', 0.0, 1.0), va.WordTiming('1', math.nan, math.nan), va.WordTiming('2', math.nan, math.nan), va.WordTiming('b', 3.0, 4.0)]
        karaoke_pipeline.fill_missing(words, 5.0)
        self.assertEqual([(w.start, w.end) for w in words[1:3]], [(1.0, 2.0), (2.0, 3.0)])
        self.assertTrue(words[1].estimated)


class FakeRunner:
    def __init__(self, root):
        self.root, self.jobs, self.enqueued = Path(root), {}, []

    def create(self, options):
        directory = Path(tempfile.mkdtemp(dir=self.root))
        job = server.Job(options, directory)
        self.jobs[job.id] = job
        return job

    def get(self, job_id):
        return self.jobs.get(job_id)

    def enqueue(self, job):
        job.state = 'queued'
        self.enqueued.append(job)

    def cancel(self, job):
        job.cancel_event.set()
        job.state = 'cancelled'


class JobApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runner = FakeRunner(self.tmp.name)
        self.original_features = server.karaoke_features
        server.karaoke_features = lambda: {'karaoke': True, 'separation': True, 'romanize': True}

    def tearDown(self):
        server.karaoke_features = self.original_features
        self.tmp.cleanup()

    def call(self, method, path, body=b'', origin=server.PAGES_ORIGIN, token='code'):
        cls = server.make_handler(None, 'code', {server.SITE_ORIGIN, server.PAGES_ORIGIN}, self.runner)
        handler = cls.__new__(cls)
        handler.headers = {'Authorization': 'Bearer ' + token, 'Origin': origin, 'Content-Length': str(len(body))}
        handler.path, handler.rfile = path, io.BytesIO(body)
        handler.reply = lambda status, payload=None: setattr(handler, 'result', (status, payload))
        getattr(handler, 'do_' + method)()
        return handler.result

    def test_github_pages_editor_can_create_upload_poll_and_cancel(self):
        request = json.dumps({'from': 1.5, 'to': 31.5, 'language': 'vi', 'lyrics': ['Em ơi', '  ', 'Hà Nội phố']}).encode()
        status, created = self.call('POST', '/v1/karaoke/jobs', request)
        self.assertEqual(status, 201)
        job = self.runner.get(created['id'])
        self.assertEqual(job.options['lyrics'], ['Em ơi', 'Hà Nội phố'])
        status, _ = self.call('PUT', f'/v1/karaoke/jobs/{job.id}/audio', b'x' * 3000)
        self.assertEqual(status, 202)
        self.assertEqual((job.directory / 'source').read_bytes(), b'x' * 3000)
        self.assertEqual(self.runner.enqueued, [job])
        self.assertEqual(self.call('GET', f'/v1/karaoke/jobs/{job.id}')[1]['state'], 'queued')
        self.assertEqual(self.call('DELETE', f'/v1/karaoke/jobs/{job.id}')[1]['state'], 'cancelled')
        self.assertEqual(self.call('PUT', f'/v1/karaoke/jobs/{job.id}/audio', b'y')[0], 404)

    def test_requests_are_validated_and_other_sites_rejected(self):
        for bad in [{'from': 5, 'to': 4}, {'from': 0, 'to': 601}, {'from': 0, 'to': 5, 'language': 'xx'}, {'from': 0, 'to': 5, 'lyrics': 'one line'}]:
            self.assertEqual(self.call('POST', '/v1/karaoke/jobs', json.dumps(bad).encode())[0], 400)
        self.assertEqual(self.call('POST', '/v1/karaoke/jobs', b'{}', origin='https://evil.example')[0], 403)
        self.assertEqual(self.call('GET', '/v1/karaoke/jobs/' + 'f' * 32)[0], 404)


if __name__ == '__main__':
    unittest.main()
