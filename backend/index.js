import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import pdfParse from 'pdf-parse';
import multer from 'multer';

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

// ElevenLabs TTS configuration
const hasElevenLabsKey = Boolean(process.env.ELEVENLABS_API_KEY);
const elevenlabs = hasElevenLabsKey ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY }) : null;
const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || 'XB0fDUnXU5powFXDhCwa'; // Charlotte - multilingual
const elevenLabsModel = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';

const analyzeSystemPrompt = `너는 대학생 과제의 주제를 분석하는 AI이다.
다음 한국어 에세이/레포트를 읽고, 3~5개의 핵심 주제를 추출하라.
각 주제는 학생이 과제를 직접 작성했는지 확인하기 위한 인터뷰에 사용된다.

응답 형식(JSON):
{
  "topics": [
    { "id": "t1", "title": "주제 제목 (간결하게)" }
  ]
}
반드시 위 JSON 형식만 반환하고, 다른 텍스트는 포함하지 마라.`;

const generateSystemPrompt = `너는 학생이 제출한 과제를 직접 작성했는지 확인하는 면접관 AI이다.

핵심 원칙:
- 질문은 반드시 "과제 본문에 있는 내용"을 직접 인용하거나 언급해야 한다.
- 과제에 없는 내용, 관련 배경지식, 심화 주제로 빠지지 않는다.
- 학생이 과제를 읽고 이해했는지, 그리고 직접 작성했는지를 과제 내용 자체로 확인한다.

질문 규칙:
1. 한국어 존댓말로 질문한다.
2. 한 번에 하나의 질문만 한다.
3. 질문에 과제 본문의 구체적 내용(문장, 표현, 수치, 사례)을 반드시 언급한다.
4. 과제에서 벗어난 일반적/추상적 질문은 금지한다.

좋은 질문 패턴:
- "과제에서 [X]라고 쓰셨는데, 왜 이렇게 표현하셨나요?"
- "여기서 [Y 사례]를 예로 드셨는데, 이 사례를 선택한 이유가 있나요?"
- "과제에 [Z 수치]가 나오는데, 이 자료는 어디서 찾으셨나요?"
- "[A]라는 주장을 하셨는데, 본인도 이 의견에 동의하시나요?"
- "이 부분을 [B]라고 쓰셨는데, 다른 표현도 고려해 보셨나요?"

금지되는 질문:
- 과제에 없는 개념이나 용어에 대한 질문
- 과제 주제와 관련된 일반적인 배경지식 질문
- 과제 내용을 넘어서는 심화/확장 질문
- 단순 요약 요청 ("이 부분을 설명해 주세요")
- 정의 질문 ("X가 무엇인가요?")`;

const summarizeSystemPrompt = `너는 학생이 과제를 직접 작성했는지 판별하는 평가자이다.

평가 목적:
인터뷰 대화를 바탕으로 학생의 "과제 소유감"을 평가한다.
- 직접 작성: 작성 과정, 의사결정, 개인적 고민을 구체적으로 설명할 수 있음
- AI 생성 후 검토: 내용은 이해하지만 작성 과정에 대한 답변이 모호함
- AI 생성 그대로 제출: 내용도 제대로 모르고, 왜 이렇게 썼는지 설명 못함

판별 기준:
1. 작성 과정 설명: "왜 이렇게 썼나요?"에 구체적으로 답변하는가?
2. 의사결정 근거: 특정 표현, 구조, 사례 선택의 이유를 설명하는가?
3. 개인적 경험: 조사 과정, 어려웠던 점, 새롭게 알게 된 점을 언급하는가?
4. 대안 인식: 다른 방법도 고려했음을 보여주는가?
5. 일관성: 과제 내용과 답변이 논리적으로 일치하는가?

위험 신호 (AI 생성 의심):
- "그냥 이렇게 쓰는 게 맞는 것 같아서요"
- 작성 과정에 대한 질문에 내용 요약으로 대답
- 구체적인 의사결정 질문에 일반적인 답변
- 과제 내용과 모순되는 설명

평가 규칙:
- 'AI:'로 시작하는 줄은 면접관 발화이며 평가 대상 아님
- '학생:'으로 시작하는 줄만 평가에 사용
- 학생이 응답하지 않았다면 평가 불가로 처리
- 적극적으로 대화에 참여한 경우 약간의 가산점 부여

응답 JSON 형식:
{
  "strengths": ["직접 작성했음을 보여주는 증거들"],
  "weaknesses": ["AI 생성 의심 또는 이해 부족 증거들"],
  "overallComment": "종합 판단: 직접 작성 가능성 높음/낮음, 근거 요약"
}`;

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
          { id: 't1', title: '주제 1' },
        ],
      };
    }
    const topics = (parsed.topics && Array.isArray(parsed.topics))
      ? parsed.topics.slice(0, 5).map((t, idx) => ({
          id: t.id || `t${idx + 1}`,
          title: t.title || `주제 ${idx + 1}`,
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
  const { topic, assignmentText, previousQA = [], studentAnswer, interviewMode } = req.body || {};
  if (!topic) {
    return res.status(400).json({ error: 'topic is required' });
  }
  const docContent = (assignmentText || '').slice(0, 14000) || '본문 없음';
  const userContext = `과제 본문:\n${docContent}\n\n현재 주제: ${topic.title}\n\n이전 Q&A:\n${previousQA.map((turn) => `${turn.role === 'ai' ? 'AI' : '학생'}: ${turn.text}`).join('\n') || '없음'}\n\n학생 최신 답변:\n${studentAnswer || '없음'}`;

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
- 핵심은 학생이 과제를 직접 작성했는지 여부이다.`;

app.post('/api/summary', async (req, res) => {
  const { transcript, topics, assignmentText, interviewMode } = req.body || {};
  if (!transcript) {
    return res.status(400).json({ error: 'transcript is required' });
  }
  const docContent = (assignmentText || '').slice(0, 14000);
  const userContent = `과제 본문:\n${docContent}\n\n주제 목록:\n${(topics || []).map((t) => t.title).join(', ')}\n\n대화 로그:\n${transcript}`;
  
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
  if (!elevenlabs) {
    return res.status(503).json({ error: 'ElevenLabs API not configured' });
  }

  try {
    const audioStream = await elevenlabs.textToSpeech.convert(elevenLabsVoiceId, {
      text: text.slice(0, 5000),
      modelId: elevenLabsModel,
      outputFormat: 'mp3_44100_128',
    });

    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': buffer.length,
    });
    res.send(buffer);
  } catch (err) {
    console.error('ElevenLabs TTS error:', err.message, err.body || '');
    return res.status(500).json({ error: 'tts_failed', detail: err.message });
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post('/api/stt', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'audio file is required' });
  }
  if (!openai) {
    return res.status(503).json({ error: 'OpenAI API not configured' });
  }
  
  const contextPrompt = req.body.context || '';
  
  try {
    const file = new File([req.file.buffer], 'audio.webm', { type: req.file.mimetype });
    
    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: file,
      language: 'ko',
      prompt: contextPrompt.slice(0, 500),
    });
    
    return res.json({ text: transcription.text });
  } catch (err) {
    console.error('stt error', err);
    return res.status(500).json({ error: 'stt_failed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
