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

const analyzeSystemPrompt = `너는 대학생 과제 이해도 인터뷰를 준비하는 조교 AI이다.\n다음 한국어 에세이/레포트를 읽고, 5개 이하의 주제 블록으로 나누고,\n각 블록의 제목과 설명, 전체 요약을 한국어로 JSON 형식으로 만들어라.\n\n응답 형식(JSON):\n{\n  "summary": "전체 내용을 한국어로 3~4문장 요약",\n  "topics": [\n    { "id": "t1", "title": "주제 제목", "description": "이 주제가 다루는 핵심 내용을 2~3문장으로 설명" }\n  ]\n}`;

const generateSystemPrompt = `너는 과제를 검사하는 교수가 아니라,\n학생이 스스로 과제 내용을 이해했는지 확인해 주는 조교 AI이다.\n\n규칙:\n- 반드시 한국어의 존댓말(예: ~습니다, ~세요)로만 질문하고 답한다.\n- 학생을 압박하기보다는, 이해를 도와주는 방향으로 질문한다.\n- 한 번에 하나의 질문만 한다.\n- 질문은 반드시 과제 본문/요약/주제 설명에 실제로 등장하는 내용과 범위에만 근거해야 한다.\n- 과제 본문에 없는 개념, 사례, 이론, 배경지식 등을 새로 만들어 질문하지 않는다.\n- "만약 ~라면?" 같은 과제 범위를 크게 벗어나는 가정이나, 과제에 전혀 언급되지 않은 사회 이슈/정책/철학을 묻지 않는다.\n- 학생에게는 과제 본문에 이미 등장한 내용/주장을 자신의 말로 다시 설명하게 하거나, 그 이유/근거/의미를 묻는 방식으로 질문한다.\n- 질문은 학생이 과제와 자신의 답변이 일치하는지 "직접 검사"하게 만드는 형식이 아니라,\n  AI가 과제 내용을 기준으로 학생의 이해도를 검증하기 위한 구체적인 내용 질문이어야 한다.\n- 예를 들어, 특정 수치/개념/주장을 물어보고 학생이 답하면,\n  그 답이 과제 본문과 일치하는지 여부는 AI가 내부적으로 판단하고 피드백해야 하며,\n  학생에게 "과제 본문과 일치하는지 다시 확인해 보세요"와 같이 메타적인 확인 요청을 하지 않는다.\n(모델 input에는 위 시스템 프롬프트와 함께, 과제 요약/현재 주제 설명/본문 발췌/이전 Q&A/학생의 최신 답변이 함께 들어갑니다.)`;

const summarizeSystemPrompt = `너는 학생의 과제 이해도와 "과제에 대한 소유감"을 평가하는 조교이다.\n대화를 읽고, 학생이 과제 내용을 얼마나 이해하고 있는지,\n실제로 과제를 읽어보고 자신의 생각에 맞게 고쳤거나 검증했는지를 추론해야 한다.\n\n일반적인 과제 유형(조사/보고서/의견 에세이)을 가정하고 다음을 살펴보라:\n- 학생이 과제의 핵심 주장과 구조(서론-본론-결론 또는 주요 항목들)를 자신의 말로 설명할 수 있는지\n- 과제에 나온 구체적인 내용(예: 수치, 사례, 인용, 정의)을 자연스럽게 언급하고 설명하는지\n- "너무 일반적인 AI스러운 말"만 반복하는지, 아니면 과제에 실제로 등장하는 디테일을 이해하고 활용하는지\n- 질문에 대한 답변이 과제 본문과 논리적으로 일관된지, 전혀 다른 이야기를 하는지\n\n이 정보를 바탕으로, 학생이 과제를 직접 작성했거나\n최소한 AI가 만들어 준 결과물을 꼼꼼히 읽고 자신의 생각에 맞게 수정·검증했을 가능성이\n높은지/낮은지를 판단하고, overallComment에 그 판단을 부드럽게 서술하라.\n\n또한, 학생의 발화 내용이 제출된 과제 본문과 얼마나 잘 일치하는지 평가하라.\n과제에 포함된 주장/근거/예시와 전혀 관련이 없는 이야기를 하는지,\n혹은 과제 내용과 모순되는 설명을 하는지 주의 깊게 살펴보라.\n\n중요:\n- 'AI:'로 시작하는 줄은 AI의 발화이며, 평가에 사용하지 않는다.\n- '학생:'으로 시작하는 줄만 학생의 이해도 평가에 사용한다.\n- 학생이 더 많은 질문에 도전했을 경우(대화 길이가 길수록),\n  일부 질문에 정확히 답하지 못하더라도, 매우 짧게만 대답하고 넘어간 경우보다\n  약간 더 긍정적인 평가를 받는 경향이 있도록 판단하라.\n- 학생이 한 마디도 하지 않았다면, strengths는 빈 배열로 두고,\n  overallComment에 "학생의 응답이 없어 이해도를 평가할 수 없습니다."와 비슷한 문장을 써라.\n\n응답 JSON 형식:\n{\n  "strengths": ["..."],\n  "weaknesses": ["..."],\n  "overallComment": "..."\n}`;

function extractTextFromResponse(response) {
  if (!response) return '';
  if (response.output && Array.isArray(response.output)) {
    const content = response.output[0]?.content;
    if (Array.isArray(content)) {
      return content.map((item) => item.text || '').join(' ').trim();
    }
  }
  // chat-completions fallback
  const choice = response.choices?.[0];
  if (choice?.message?.content) return choice.message.content;
  return '';
}

async function runLLM({ messages, maxTokens = 800, responseFormat }) {
  if (!openai) {
    return { fallback: true, text: '', raw: null };
  }
  const response = await openai.responses.create({
    model,
    max_output_tokens: maxTokens,
    input: messages,
    // `thinking` currently rejected by some model variants; omit for compatibility.
    text: responseFormat ? { format: responseFormat } : undefined,
  });
  const text = extractTextFromResponse(response);
  return { fallback: false, text, raw: response };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
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
      maxTokens: 700,
      responseFormat: 'json_object',
    });

	    let parsed = safeParseJson(llmText);
	    if (!parsed) {
	      parsed = {
	        summary: '요약을 생성하지 못했습니다. 간단히 핵심을 다시 적어 주세요.',
	        topics: [
	          { id: 't1', title: '주제 1', description: 'AI 키가 없어 기본 주제만 생성되었습니다.' },
	        ],
	      };
	    }
	    return res.json({ analysis: parsed, text: assignmentPlain, fallback });
	  } catch (err) {
	    console.error('analyze error', err);
	    return res.status(500).json({ error: 'analyze_failed', detail: err.message || 'unknown' });
	  }
	});

app.post('/api/question', async (req, res) => {
  const { summary, topic, excerpt, previousQA = [], studentAnswer } = req.body || {};
  if (!summary || !topic) {
    return res.status(400).json({ error: 'summary and topic are required' });
  }
  const userContext = `과제 요약:\n${summary}\n\n현재 주제: ${topic.title}\n${topic.description}\n\n본문 발췌:\n${excerpt || '발췌 없음'}\n\n이전 Q&A:\n${previousQA.map((turn) => `${turn.role === 'ai' ? 'AI' : '학생'}: ${turn.text}`).join('\n') || '없음'}\n\n학생 최신 답변:\n${studentAnswer || '없음'}`;

  try {
    const { fallback, text } = await runLLM({
      messages: [
        { role: 'system', content: generateSystemPrompt },
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

app.post('/api/summary', async (req, res) => {
  const { transcript, summary, topics } = req.body || {};
  if (!transcript) {
    return res.status(400).json({ error: 'transcript is required' });
  }
  const userContent = `과제 요약:\n${summary || ''}\n\n주제 목록:\n${(topics || []).map((t) => `${t.title}: ${t.description}`).join('\n')}\n\n대화 로그:\n${transcript}`;
  try {
    const { fallback, text } = await runLLM({
      messages: [
        { role: 'system', content: summarizeSystemPrompt },
        { role: 'user', content: userContent.slice(0, 15000) },
      ],
      maxTokens: 600,
      responseFormat: 'json_object',
    });
    let parsed = safeParseJson(text);
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

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
