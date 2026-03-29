import { ai, withRetry, Modality } from "./BaseAgent";
import firebaseAI from "../utils/firebaseAI";
import { getMockPodcastScript } from "../utils/mockData";
import { speakText, isWebSpeechAPIAvailable, createMockAudioDataUrl } from "../utils/textToSpeechUtils";

export const generateSpeech = async (text: string, voice: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr' = 'Kore') => {
  try {
    // Try direct TTS model (firebaseAI doesn't support audio)
    console.log('📢 Attempting Gemini TTS generation...');
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Read this news briefing clearly: ${text}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    }));

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio && base64Audio.length > 100) { // Validate audio data is substantial
      console.log('✅ Gemini TTS success');
      return `data:audio/wav;base64,${base64Audio}`;
    } else {
      console.warn('⚠️ Gemini returned empty audio data, falling back to Web Speech API');
    }
  } catch (e) {
    console.warn("⚠️ Gemini TTS failed, falling back to Web Speech API:", e);
  }

  // Fallback: Use browser Web Speech API (always works, no quota limits)
  console.log('🎤 Using Web Speech API for TTS (browser-native, free, always available)');
  // Return a special marker that indicates we should use Web Speech API
  return `ws-api:///${encodeURIComponent(text)}`;
};

export const generatePodcastScript = async (topics: string[], persona: string, specificTopic?: string) => {
  const prompt = specificTopic 
    ? `Create a conversational podcast script for a ${persona} specifically about this topic: ${specificTopic}. 
       Include context from these general interests if relevant: ${topics.join(', ')}. 
       The script should have two hosts, Alex and Sam. 
       Alex is analytical and Sam is enthusiastic. 
       Keep it engaging and under 3 minutes.
       Format the output as a single string of text that can be read aloud.`
    : `Create a conversational podcast script for a ${persona} based on these topics: ${topics.join(', ')}. 
       The script should have two hosts, Alex and Sam. 
       Alex is analytical and Sam is enthusiastic. 
       Keep it engaging and under 3 minutes.
       Format the output as a single string of text that can be read aloud.`;

  try {
    console.log('📝 Generating podcast script with Gemini...');
    // Use client-side Firebase AI first (distributed quota)
    const script = await firebaseAI.generateText(prompt, false); // Use flash model
    console.log('✅ Podcast script generated');
    return script;
  } catch (error) {
    console.warn('Podcast script generation failed, using mock script:', error);
    // Use mock podcast script as fallback
    return getMockPodcastScript(specificTopic || topics[0] || 'business news', persona);
  }
};

export const generateMultiSpeakerPodcast = async (script: string) => {
  try {
    console.log('🎙️  Attempting Gemini multi-speaker podcast generation...');
    const response = await withRetry(() => ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: script }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          multiSpeakerVoiceConfig: {
            speakerVoiceConfigs: [
              {
                speaker: 'Alex',
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: 'Kore' }
                }
              },
              {
                speaker: 'Sam',
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: 'Puck' }
                }
              }
            ]
          }
        }
      }
    }));

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      console.log('✅ Gemini podcast generation success');
      return `data:audio/wav;base64,${base64Audio}`;
    }
  } catch (e) {
    console.warn("Gemini podcast generation failed, falling back to Web Speech API:", e);
  }

  // Fallback: Use Web Speech API to read the script
  if (isWebSpeechAPIAvailable()) {
    try {
      console.log('🎤 Using Web Speech API for podcast (browser-native, free)');
      return `ws-api:///${encodeURIComponent(script)}`;
    } catch (error) {
      console.error('Web Speech API podcast fallback failed:', error);
    }
  }

  console.warn('🚫 Podcast generation failed');
  return null;
};
