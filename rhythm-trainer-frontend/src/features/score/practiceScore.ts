import type { ScoreDocument } from '../../core/sampleScore';
import practiceXml from './fixtures/c-major-practice.musicxml?raw';
import { parseMusicXml } from './musicXmlParser';

const parsed = parseMusicXml(practiceXml, 'c-major-practice.musicxml');

export const practiceScoreDocument: ScoreDocument = {
  ...parsed,
  meta: {
    ...parsed.meta,
    title: 'C 大调钢琴练习曲',
    composer: '原创示例',
    sourceFile: 'src/features/score/fixtures/c-major-practice.musicxml',
    integration: 'fixture',
    integrationNote: '内置 C 大调钢琴练习曲示例（MusicXML 解析生成）。',
  },
};
