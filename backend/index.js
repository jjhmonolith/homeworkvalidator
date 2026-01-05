import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import pdfParse from 'pdf-parse';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4010;
const FRONT_ORIGINS = (process.env.FRONT_ORIGIN || 'http://localhost:3010')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow no-origin (curl/postman) or exact match after trimming trailing slash.
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/$/, '');
      const allowed = FRONT_ORIGINS.includes(normalized);
      return callback(allowed ? null : new Error('CORS blocked'), allowed);
    },
  }),
);
app.use(express.json({ limit: '15mb' }));

const hasApiKey = Boolean(process.env.OPENAI_API_KEY);
const openai = hasApiKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const model = process.env.OPENAI_MODEL || 'gpt-5.1'; // target: gpt-5.1-mini when available

const analyzeSystemPrompt = `너는 대학생 과제 이해도 인터뷰를 준비하는 조교 AI이다.\n다음 한국어 에세이/레포트를 읽고, 5개 이하의 주제 블록으로 나누고,\n각 블록의 제목과 설명을 한국어로 JSON 형식으로 만들어라.\n\n응답 형식(JSON):\n{\n  "topics": [\n    { "id": "t1", "title": "주제 제목", "description": "이 주제가 다루는 핵심 내용을 2~3문장으로 설명" }\n  ]\n}\n반드시 위 JSON 형식만 반환하고, 다른 텍스트는 포함하지 마라. 요약은 만들지 않는다.`;

const generateSystemPrompt = `너는 학생의 과제 이해도를 확인하는 친절한 조교 AI이다.

핵심 규칙:
1. 한국어 존댓말로 질문한다.
2. 한 번에 하나의 질문만 한다.
3. 과제 본문에 실제로 등장하는 내용만 질문한다.
4. 과제에 없는 개념이나 가정을 만들어 질문하지 않는다.
5. 학생이 과제 내용을 자신의 말로 설명하게 하거나, 이유/근거를 묻는다.
6. 압박하지 말고 이해를 돕는 방향으로 질문한다.

질문 예시:
- "이 부분에서 말하는 핵심 주장이 무엇인지 설명해 주시겠어요?"
- "왜 이런 결론에 도달했는지 이유를 말씀해 주세요."
- "여기서 언급한 사례가 어떤 의미인지 설명해 주시겠어요?"`;

const summarizeSystemPrompt = `너는 학생의 과제 이해도와 "과제에 대한 소유감"을 평가하는 조교이다.\n대화를 읽고, 학생이 과제 내용을 얼마나 이해하고 있는지,\n실제로 과제를 읽어보고 자신의 생각에 맞게 고쳤거나 검증했는지를 추론해야 한다.\n\n일반적인 과제 유형(조사/보고서/의견 에세이)을 가정하고 다음을 살펴보라:\n- 학생이 과제의 핵심 주장과 구조(서론-본론-결론 또는 주요 항목들)를 자신의 말로 설명할 수 있는지\n- 과제에 나온 구체적인 내용(예: 수치, 사례, 인용, 정의)을 자연스럽게 언급하고 설명하는지\n- "너무 일반적인 AI스러운 말"만 반복하는지, 아니면 과제에 실제로 등장하는 디테일을 이해하고 활용하는지\n- 질문에 대한 답변이 과제 본문과 논리적으로 일관된지, 전혀 다른 이야기를 하는지\n\n이 정보를 바탕으로, 학생이 과제를 직접 작성했거나\n최소한 AI가 만들어 준 결과물을 꼼꼼히 읽고 자신의 생각에 맞게 수정·검증했을 가능성이\n높은지/낮은지를 판단하고, overallComment에 그 판단을 부드럽게 서술하라.\n\n또한, 학생의 발화 내용이 제출된 과제 본문과 얼마나 잘 일치하는지 평가하라.\n과제에 포함된 주장/근거/예시와 전혀 관련이 없는 이야기를 하는지,\n혹은 과제 내용과 모순되는 설명을 하는지 주의 깊게 살펴보라.\n\n중요:\n- 'AI:'로 시작하는 줄은 AI의 발화이며, 평가에 사용하지 않는다.\n- '학생:'으로 시작하는 줄만 학생의 이해도 평가에 사용한다.\n- 학생이 더 많은 질문에 도전했을 경우(대화 길이가 길수록),\n  일부 질문에 정확히 답하지 못하더라도, 매우 짧게만 대답하고 넘어간 경우보다\n  약간 더 긍정적인 평가를 받는 경향이 있도록 판단하라.\n- 학생이 한 마디도 하지 않았다면, strengths는 빈 배열로 두고,\n  overallComment에 "학생의 응답이 없어 이해도를 평가할 수 없습니다."와 비슷한 문장을 써라.\n\n응답 JSON 형식:\n{\n  "strengths": ["..."],\n  "weaknesses": ["..."],\n  "overallComment": "..."\n}`;

function extractFromResponse(response) {
  let text = '';
  if (!response) return { text: '' };

  // Debug: log response structure
  console.log('Response structure:', JSON.stringify({
    hasOutput: !!response.output,
    hasOutputText: !!response.output_text,
    outputLength: response.output?.length,
    firstOutputType: response.output?.[0]?.type,
    contentLength: response.output?.[0]?.content?.length,
  }, null, 2));

  // Method 1: SDK convenience property (recommended)
  if (response.output_text) {
    text = response.output_text;
    console.log('Extracted via output_text, length:', text.length);
    return { text };
  }

  // Method 2: Manual extraction from output array
  if (response.output && Array.isArray(response.output)) {
    for (const item of response.output) {
      if (item.type === 'message' && item.content) {
        for (const contentItem of item.content) {
          if (contentItem.type === 'output_text' && contentItem.text) {
            text += contentItem.text;
          }
        }
      }
    }
    text = text.trim();
    if (text) {
      console.log('Extracted via output array, length:', text.length);
      return { text };
    }
  }

  // Method 3: Chat completions fallback
  const choice = response.choices?.[0];
  if (choice?.message?.content) {
    text = choice.message.content;
    console.log('Extracted via choices fallback, length:', text.length);
  }

  return { text };
}

async function runLLM({ messages, maxTokens = 800, responseFormat }) {
  if (!openai) {
    return { fallback: true, text: '', raw: null };
  }
  const response = await openai.responses.create({
    model,
    max_output_tokens: maxTokens,
    input: messages,
    text: responseFormat ? { format: { type: responseFormat } } : undefined,
  });
  const { text } = extractFromResponse(response);
  return { fallback: false, text, raw: response };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    console.log('safeParseJson error:', err.message);
    return null;
  }
}

function parseJsonRelaxed(text) {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '');
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  const sliced = cleaned.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(sliced);
  } catch (err) {
    console.log('parseJsonRelaxed first attempt error:', err.message);
    try {
      // remove control characters and retry
      const stripped = sliced.replace(/[\u0000-\u001f]+/g, '');
      return JSON.parse(stripped);
    } catch (err2) {
      console.log('parseJsonRelaxed second attempt error:', err2.message);
      return null;
    }
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model, hasApiKey });
});

	app.post('/api/analyze', async (req, res) => {
	  const { assignmentText, pdfBase64 } = req.body || {};
	  if (!assignmentText && !pdfBase64) {
	    return res.status(400).json({ error: 'assignmentText or pdfBase64 is required' });
	  }
	  try {
	    let assignmentPlain = assignmentText;
	    if (!assignmentPlain && pdfBase64) {
	      try {
	        const buffer = Buffer.from(pdfBase64, 'base64');
	        const parsed = await pdfParse(buffer);
	        assignmentPlain = parsed.text;
	      } catch (parseErr) {
	        console.error('pdf parse error', parseErr);
	        return res.status(400).json({ error: 'failed_to_extract_text' });
	      }
	    }
	    if (!assignmentPlain) {
	      return res.status(400).json({ error: 'failed_to_extract_text' });
	    }

    const { fallback, text: llmText } = await runLLM({
      messages: [
        { role: 'system', content: analyzeSystemPrompt },
        { role: 'user', content: (assignmentPlain || '').slice(0, 16000) },
      ],
      maxTokens: 2000,
      responseFormat: 'json_object',
    });

    // Debug: Log full text before parsing
    console.log('=== FULL LLM TEXT START ===');
    console.log(llmText);
    console.log('=== FULL LLM TEXT END ===');

    let parsed = safeParseJson(llmText) || parseJsonRelaxed(llmText);
    if (!parsed) {
      console.warn('analyze JSON parse failed', {
        fallback,
        textLength: llmText?.length || 0,
        snippet: (llmText || '').slice(0, 400),
        endSnippet: (llmText || '').slice(-200),
      });
      parsed = {
        topics: [
          { id: 't1', title: '주제 1', description: 'AI 응답을 파싱하지 못했습니다. 다시 시도해 주세요.' },
        ],
      };
    }
    // Normalize topics length and ids
    const topics = (parsed.topics && Array.isArray(parsed.topics))
      ? parsed.topics.slice(0, 5).map((t, idx) => ({
          id: t.id || `t${idx + 1}`,
          title: t.title || `주제 ${idx + 1}`,
          description: t.description || '',
        }))
      : [];
    return res.json({ analysis: { topics }, text: assignmentPlain, fallback });
	  } catch (err) {
	    console.error('analyze error', err);
	    return res.status(500).json({ error: 'analyze_failed', detail: err.message || 'unknown' });
	  }
	});

const voiceModeAddendum = `
추가 규칙 (음성 인터뷰 모드):
- 현재 학생은 음성으로 답변하고 있으며, AI의 질문도 음성으로 읽어주고 있다.
- 학생에게 "써주세요", "작성해 주세요", "적어주세요" 등 텍스트 작성을 요구하지 않는다.
- 대신 "말씀해 주세요", "설명해 주세요", "답변해 주세요" 등 구두 응답을 요청한다.
- 질문은 듣기 쉽고 간결하게 한다. 너무 긴 질문은 피한다.`;

app.post('/api/question', async (req, res) => {
  const { summary, topic, excerpt, assignmentText, previousQA = [], studentAnswer, interviewMode } = req.body || {};
  if (!topic) {
    return res.status(400).json({ error: 'topic is required' });
  }
  const docContent = (assignmentText || excerpt || '').slice(0, 14000) || '본문 없음';
  const userContext = `과제 본문(일부):\n${docContent}\n\n현재 주제: ${topic.title}\n${topic.description}\n\n요약(선택):\n${summary || '제공되지 않음'}\n\n이전 Q&A:\n${previousQA.map((turn) => `${turn.role === 'ai' ? 'AI' : '학생'}: ${turn.text}`).join('\n') || '없음'}\n\n학생 최신 답변:\n${studentAnswer || '없음'}`;

  const systemPrompt = interviewMode === 'voice' 
    ? generateSystemPrompt + voiceModeAddendum 
    : generateSystemPrompt;

  try {
    const { fallback, text } = await runLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContext.slice(0, 15000) },
      ],
      maxTokens: 300,
    });
    const question = text || '주제와 관련된 내용을 더 자세히 설명해 주시겠어요?';
    return res.json({ question, fallback });
  } catch (err) {
    console.error('question error', err);
    return res.status(500).json({ error: 'question_failed' });
  }
});

const voiceSummaryAddendum = `
추가 참고 (음성 인터뷰):
- 이 인터뷰는 음성으로 진행되었다. 학생의 답변은 음성 인식(STT)으로 변환된 텍스트이다.
- 음성 인식 특성상 오탈자, 띄어쓰기 오류, 동음이의어 오인식이 있을 수 있다. 이를 감안하여 평가한다.
- 구어체 표현, 말 더듬음, 반복 등은 자연스러운 것이므로 부정적으로 평가하지 않는다.
- 핵심은 학생이 과제 내용을 이해하고 있는지 여부이다.`;

app.post('/api/summary', async (req, res) => {
  const { transcript, topics, assignmentText, interviewMode } = req.body || {};
  if (!transcript) {
    return res.status(400).json({ error: 'transcript is required' });
  }
  const docContent = (assignmentText || '').slice(0, 14000);
  const userContent = `과제 본문(일부):\n${docContent}\n\n주제 목록:\n${(topics || []).map((t) => `${t.title}: ${t.description}`).join('\n')}\n\n대화 로그:\n${transcript}`;
  
  const systemPrompt = interviewMode === 'voice'
    ? summarizeSystemPrompt + voiceSummaryAddendum
    : summarizeSystemPrompt;

  try {
    const { fallback, text } = await runLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent.slice(0, 15000) },
      ],
      maxTokens: 2000,
      responseFormat: 'json_object',
    });
    let parsed = safeParseJson(text) || parseJsonRelaxed(text);
    if (!parsed) {
      parsed = {
        strengths: [],
        weaknesses: ['요약 생성에 실패했습니다. 다시 시도해 주세요.'],
        overallComment: '학생의 응답이 없어 이해도를 평가할 수 없습니다.',
      };
    }
    return res.json({ summary: parsed, fallback });
  } catch (err) {
    console.error('summary error', err);
    return res.status(500).json({ error: 'summary_failed' });
  }
});

app.post('/api/tts', async (req, res) => {
  const { text } = req.body || {};
  if (!text) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!openai) {
    return res.status(503).json({ error: 'OpenAI API not configured' });
  }
  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'nova',
      input: text.slice(0, 4096),
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    console.error('tts error', err);
    return res.status(500).json({ error: 'tts_failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
