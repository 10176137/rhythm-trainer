import { useEffect, useState } from 'react';
import { trainingRepository } from '../../services/trainingRepository';
import type { GeneratedSkillDrill, SkillDrillRequest, TrainingCatalog } from '../../../shared/training-contract';

/** UI request lifecycle only. A response for old controls can never start a take. */
export function useSkillDrill(input: SkillDrillRequest) {
  const [catalog, setCatalog] = useState<TrainingCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [generationRetry, setGenerationRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; drill: GeneratedSkillDrill | null; error: string }>({ key: '', drill: null, error: '' });
  const requestKey = JSON.stringify(input);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setCatalogError('');
    void trainingRepository.catalog(controller.signal).then((value) => {
      if (current) setCatalog(value);
    }).catch((error: unknown) => {
      if (current) setCatalogError(error instanceof Error ? error.message : '训练目录载入失败，请重试。');
    });
    return () => { current = false; controller.abort(); };
  }, [catalogRetry]);
  useEffect(() => {
    if (!catalog) return;
    let current = true;
    const controller = new AbortController();
    setResult({ key: requestKey, drill: null, error: '' });
    const timer = window.setTimeout(() => {
      void trainingRepository.skillDrill(JSON.parse(requestKey) as SkillDrillRequest, controller.signal).then((drill) => {
        if (current) setResult({ key: requestKey, drill, error: '' });
      }).catch((error: unknown) => {
        if (current) setResult({ key: requestKey, drill: null, error: error instanceof Error ? error.message : '练习谱生成失败，请重试。' });
      });
    }, 150);
    return () => { current = false; controller.abort(); window.clearTimeout(timer); };
  }, [catalog, requestKey, generationRetry]);
  return {
    catalog, catalogError,
    generated: result.key === requestKey ? result.drill : null,
    generationError: result.key === requestKey ? result.error : '',
    retryCatalog: () => setCatalogRetry((value) => value + 1),
    retryGeneration: () => setGenerationRetry((value) => value + 1),
  };
}
