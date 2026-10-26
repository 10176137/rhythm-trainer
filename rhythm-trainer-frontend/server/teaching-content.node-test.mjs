import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LESSON_CATALOG,
  getLessonById,
  getLessonCatalog,
  lessonViewForRun,
  learnerMessageFor,
} from './teaching-content.mjs';

test('catalog ships 8 validated lessons with unique ids and resolved prerequisites', () => {
  assert.equal(LESSON_CATALOG.length, 8);
  const ids = new Set(LESSON_CATALOG.map((lesson) => lesson.lessonId));
  assert.equal(ids.size, 8);
  for (const lesson of LESSON_CATALOG) {
    for (const prerequisite of lesson.prerequisites) {
      assert.equal(ids.has(prerequisite), true, `${lesson.lessonId} 前置 ${prerequisite} 未定义`);
    }
  }
});

test('every lesson covers all four hands-progression phases with real coaching', () => {
  for (const lesson of LESSON_CATALOG) {
    for (const phase of ['hand-single-1', 'hand-single-2', 'hands-together', 'pass-check']) {
      const tip = lesson.coachingByPhase[phase];
      assert.equal(typeof tip?.coaching, 'string', `${lesson.lessonId} 缺 ${phase} coaching`);
      assert.ok(tip.coaching.length >= 10, `${lesson.lessonId} ${phase} coaching 太短`);
    }
    assert.ok(lesson.explainScript.explanation.length >= 20, `${lesson.lessonId} 讲解太短`);
    assert.ok(lesson.feedbackRules.length >= 3, `${lesson.lessonId} 反馈规则太少`);
  }
});

test('catalog export is a detached deep copy (mutation cannot poison the source)', () => {
  const copy = getLessonCatalog();
  copy[0].title = 'hacked';
  copy[0].feedbackRules.pop();
  assert.notEqual(getLessonCatalog()[0].title, 'hacked');
  assert.equal(getLessonById(copy[0].lessonId).feedbackRules.length, copy[0].feedbackRules.length + 1);
});

test('lessonViewForRun keys coaching by progression step ids and freezes nothing required', () => {
  const view = lessonViewForRun(getLessonById('steady-beat-hands'));
  assert.deepEqual(Object.keys(view.coachingByStepId).sort(), ['hand-1', 'hand-2', 'hands-together', 'pass-check']);
  assert.equal(view.explainScript.title, '什么是“稳”');
  assert.match(view.transferNote, /不会自动计为通过/);
  assert.equal(lessonViewForRun(null), null);
});

test('learnerMessageFor prefers lesson words and falls back to policy text', () => {
  const lesson = getLessonById('steady-beat-hands');
  // Problem-level codes arrive via the selected prescription's ruleId.
  const fromLesson = learnerMessageFor(lesson, {
    reasonCode: 'REMEDIATION_REQUIRED',
    prescription: { ruleId: 'LOCAL_ONSET_V1' },
  }, 'policy');
  assert.equal(fromLesson.source, 'lesson');
  assert.match(fromLesson.message, /赶|拖/);
  // Stage-level codes arrive as the decision reasonCode directly.
  const byReason = learnerMessageFor(lesson, { reasonCode: 'INSUFFICIENT_SCORE_EVIDENCE' }, 'policy');
  assert.equal(byReason.source, 'lesson');
  const fallback = learnerMessageFor(lesson, { reasonCode: 'UNKNOWN_CODE_X' }, '默认策略文案');
  assert.equal(fallback.source, 'policy');
  assert.equal(fallback.message, '默认策略文案');
});
