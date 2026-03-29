import React, { useState, useEffect, useRef } from 'react';
import { 
  LayoutDashboard, 
  Newspaper, 
  Navigation, 
  Video, 
  TrendingUp, 
  Languages,
  User,
  LogOut,
  ChevronRight,
  Play,
  Share2,
  ArrowRight,
  Loader2,
  AlertCircle,
  BookOpen,
  MessageSquare,
  Send,
  ExternalLink,
  X,
  Sun,
  Moon,
  Globe,
  RefreshCw,
  Mic,
  Volume2,
  Pause,
  Headphones
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import Markdown from 'react-markdown';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User as FirebaseUser
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  onSnapshot,
  query,
  orderBy,
  limit,
  Timestamp
} from 'firebase/firestore';
import { 
  generateBriefingStream, 
  generatePersonalizedFeed, 
  translateNews, 
  getEntityDetails 
} from './agents/NewsNavigatorAgent';
import { generateStoryArc } from './agents/StoryArcAgent';
import { generateStorySegment } from './agents/StoryModeAgent';
import { generateImage } from './agents/ImageGenerationAgent';
import { generateAndCacheImage, getDefaultImage } from './utils/imageGenerationUtils';
import { chatWithNews } from './agents/NewsChatAgent';
import { generateSpeech, generatePodcastScript, generateMultiSpeakerPodcast } from './agents/VoiceAgent';
import { speakText } from './utils/textToSpeechUtils';

// --- Types ---
type Persona = 'investor' | 'founder' | 'student';

interface UserProfile {
  uid: string;
  displayName: string;
  persona: Persona;
  interests: string[];
}

interface StoryArcData {
  title: string;
  timeline: { date: string; event: string; sentiment: number }[];
  keyPlayers: string[];
  predictions: string[];
}

// --- Components ---

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [hasError, setHasError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const handleError = (e: ErrorEvent) => {
      setHasError(true);
      setErrorMsg(e.message);
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    let displayMsg = errorMsg;
    try {
      // Check if it's our custom Firestore error JSON
      if (errorMsg.includes('{"error":')) {
        const parsed = JSON.parse(errorMsg.substring(errorMsg.indexOf('{')));
        if (parsed.operationType) {
          displayMsg = `Database Error: Could not ${parsed.operationType} data at ${parsed.path}. ${parsed.error}`;
        }
      }
    } catch (e) {
      // Fallback to original message
    }

    return (
      <div className="min-h-screen flex items-center justify-center bg-red-50 p-4 transition-colors duration-300">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-red-100">
          <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h2>
          <p className="text-gray-600 mb-6">{displayMsg}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full py-3 bg-red-500 text-white rounded-xl font-semibold hover:bg-red-600 transition-colors"
          >
            Reload Application
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

const Onboarding = ({ onComplete }: { onComplete: (persona: Persona, interests: string[]) => void }) => {
  const [step, setStep] = useState(1);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [interestsInput, setInterestsInput] = useState('');

  const personas: { id: Persona; title: string; desc: string; icon: any }[] = [
    { id: 'investor', title: 'Mutual Fund Investor', desc: 'Portfolio-relevant stories and market shifts.', icon: TrendingUp },
    { id: 'founder', title: 'Startup Founder', desc: 'Funding news, competitor moves, and growth.', icon: LayoutDashboard },
    { id: 'student', title: 'Student / Learner', desc: 'Explainer-first content and deep-dives.', icon: Newspaper },
  ];

  if (step === 1) {
    return (
      <div className="max-w-5xl mx-auto">
        <div className="mb-12">
          <h2 className="text-4xl font-black text-gray-900 tracking-tight mb-4">Choose your persona.</h2>
          <p className="text-gray-500 text-lg">We'll tailor your newsroom to your specific professional needs.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {personas.map((p) => (
            <motion.button
              key={p.id}
              whileHover={{ scale: 1.02, y: -5 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => { setPersona(p.id); setStep(2); }}
              className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 text-left flex flex-col items-start group hover:border-orange-200 transition-all"
            >
              <div className="w-12 h-12 bg-orange-50 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-orange-100 transition-colors">
                <p.icon className="w-6 h-6 text-orange-600" />
              </div>
              <h3 className="text-xl font-bold text-gray-900 mb-2">{p.title}</h3>
              <p className="text-gray-500 text-sm leading-relaxed">{p.desc}</p>
              <div className="mt-8 flex items-center text-orange-600 font-semibold text-sm">
                Select Persona <ChevronRight className="w-4 h-4 ml-1" />
              </div>
            </motion.button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-12">
        <h2 className="text-4xl font-black text-gray-900 tracking-tight mb-4">What are your interests?</h2>
        <p className="text-gray-500 text-lg">Enter topics you care about (e.g., AI, Fintech, Semiconductors).</p>
      </div>
      <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
        <input
          type="text"
          value={interestsInput}
          onChange={(e) => setInterestsInput(e.target.value)}
          placeholder="e.g. AI, Green Energy, IPOs"
          className="w-full px-6 py-4 bg-gray-50 border-none rounded-2xl focus:ring-2 focus:ring-orange-500/20 text-lg mb-6"
        />
        <button
          onClick={() => {
            const interests = interestsInput.split(',').map(i => i.trim()).filter(i => i.length > 0);
            if (persona) onComplete(persona, interests);
          }}
          disabled={!interestsInput.trim()}
          className="w-full py-4 bg-orange-500 text-white rounded-2xl font-bold text-lg hover:bg-orange-600 transition-all disabled:opacity-50"
        >
          Finish Setup
        </button>
        <button 
          onClick={() => setStep(1)}
          className="w-full mt-4 py-2 text-gray-400 font-semibold hover:text-gray-600 transition-all"
        >
          Go Back
        </button>
      </div>
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [activeTab, setActiveTab] = useState('feed');
  
  // Feature States
  const [feed, setFeed] = useState<string[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [selectedArticle, setSelectedArticle] = useState<string | null>(null);
  const [articleContent, setArticleContent] = useState('');
  const [originalArticleContent, setOriginalArticleContent] = useState('');
  const [articleImage, setArticleImage] = useState<string | null>(null);
  const [loadingArticle, setLoadingArticle] = useState(false);

  const [briefing, setBriefing] = useState('');
  const [originalBriefing, setOriginalBriefing] = useState('');
  const [briefingImage, setBriefingImage] = useState<string | null>(null);
  const [briefingTopic, setBriefingTopic] = useState('Global Tech Layoffs 2026');
  const [generatingBriefing, setGeneratingBriefing] = useState(false);
  const [briefingSources, setBriefingSources] = useState<{ title: string; url: string }[]>([]);

  const [storyArc, setStoryArc] = useState<StoryArcData | null>(null);
  const [arcTopic, setArcTopic] = useState('The Rise of Sovereign AI Clouds');
  const [generatingArc, setGeneratingArc] = useState(false);

  const [translating, setTranslating] = useState(false);
  
  // Story State
  const [storyTopic, setStoryTopic] = useState('The Future of AI Regulation');
  const [currentStory, setCurrentStory] = useState<{ story: string; imageUrl?: string; imagePrompt?: string } | null>(null);
  const [isGeneratingStory, setIsGeneratingStory] = useState(false);
  const [isRegeneratingImage, setIsRegeneratingImage] = useState(false);

  // Chat State
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{ role: 'user' | 'model'; text: string; sources?: { title: string; url: string }[] }[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);

  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);
  const [entityDetails, setEntityDetails] = useState<{ text: string; sources: { title: string; url: string }[] } | null>(null);
  const [loadingEntityDetails, setLoadingEntityDetails] = useState(false);

  // Audio State
  const [isPlaying, setIsPlaying] = useState(false);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [isGeneratingSpeech, setIsGeneratingSpeech] = useState(false);
  const [activeAudioId, setActiveAudioId] = useState<string | null>(null);

  // Podcast State
  const [isGeneratingPodcast, setIsGeneratingPodcast] = useState(false);
  const [podcastAudio, setPodcastAudio] = useState<string | null>(null);
  const [podcastTopic, setPodcastTopic] = useState('');

  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [language, setLanguage] = useState('English');

  const VERNACULAR_LANGS = ['Hindi', 'Tamil', 'Telugu', 'Bengali', 'Marathi'];
  const GLOBAL_LANGS = ['English', 'Spanish', 'French', 'German', 'Japanese'];
  const ALL_LANGS = [...GLOBAL_LANGS, ...VERNACULAR_LANGS];

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.style.colorScheme = 'light';
    }
  }, [theme]);

  // Automatic Translation Effect
  useEffect(() => {
    const translateAll = async () => {
      if (language === 'English') {
        setArticleContent(originalArticleContent);
        setBriefing(originalBriefing);
        return;
      }

      // Only translate if content exists and generation is finished
      if (!originalArticleContent && !originalBriefing) return;
      if (loadingArticle || generatingBriefing) return;

      setTranslating(true);
      try {
        if (originalArticleContent) {
          const translated = await translateNews(originalArticleContent, language);
          setArticleContent(translated);
        }
        if (originalBriefing) {
          const translated = await translateNews(originalBriefing, language);
          setBriefing(translated);
        }
      } catch (e) {
        console.error("Translation Error:", e);
      } finally {
        setTranslating(false);
      }
    };

    translateAll();
  }, [language, originalArticleContent, originalBriefing, loadingArticle, generatingBriefing]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const docRef = doc(db, 'users', u.uid);
        try {
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            setProfile(docSnap.data() as UserProfile);
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, `users/${u.uid}`);
        }
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (error: any) {
      if (error.code !== 'auth/cancelled-popup-request' && error.code !== 'auth/popup-closed-by-user') {
        console.error("Login Error:", error);
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleOnboardingComplete = async (persona: Persona, interests: string[]) => {
    if (!user) return;
    const newProfile: UserProfile = {
      uid: user.uid,
      displayName: user.displayName || 'User',
      persona,
      interests
    };
    try {
      await setDoc(doc(db, 'users', user.uid), newProfile);
      setProfile(newProfile);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${user.uid}`);
    }
  };

  const formatError = (e: any) => {
    const errorStr = typeof e === 'string' ? e : (e.message || JSON.stringify(e));
    if (errorStr.includes('429') || errorStr.includes('RESOURCE_EXHAUSTED')) {
      return "The news engine is currently busy (quota exceeded). We're automatically retrying with a lighter model, but if this persists, please wait a few seconds and try again.";
    }
    return "An unexpected error occurred. Please try again later.";
  };

  const handleArticleClick = async (item: string) => {
    const [title] = item.split(':');
    setSelectedArticle(title.trim());
    setLoadingArticle(true);
    setArticleContent(''); // Clear previous content
    setOriginalArticleContent('');
    setArticleImage(null);
    try {
      // Generate image in parallel with briefing stream
      generateAndCacheImage(title.trim()).then(url => setArticleImage(url || getDefaultImage(title)));
      
      let fullContent = '';
      await generateBriefingStream(
        profile?.persona || 'investor', 
        title.trim(),
        (chunk) => {
          fullContent += chunk;
          // If language is English, update display immediately
          if (language === 'English') {
            setArticleContent(fullContent);
          }
        }
      );
      setOriginalArticleContent(fullContent);
    } catch (e) {
      console.error(e);
      setArticleContent(formatError(e));
    } finally {
      setLoadingArticle(false);
    }
  };

  const fetchPersonalizedFeed = async () => {
    if (!profile) return;
    setLoadingFeed(true);
    try {
      const news = await generatePersonalizedFeed(profile.persona, profile.interests);
      setFeed(news);
    } catch (e) {
      console.error(e);
      setFeed([formatError(e)]);
    } finally {
      setLoadingFeed(false);
    }
  };

  useEffect(() => {
    if (profile && activeTab === 'feed' && feed.length === 0) {
      fetchPersonalizedFeed();
    }
  }, [profile, activeTab]);

  const handleGenerateBriefing = async () => {
    if (!profile) return;
    setGeneratingBriefing(true);
    setBriefing(''); // Clear previous briefing
    setOriginalBriefing('');
    setBriefingImage(null);
    setBriefingSources([]);
    try {
      // Generate image in parallel
      generateAndCacheImage(briefingTopic).then(url => setBriefingImage(url || getDefaultImage(briefingTopic)));

      let fullContent = '';
      await generateBriefingStream(
        profile.persona, 
        briefingTopic,
        (chunk) => {
          fullContent += chunk;
          // If language is English, update display immediately
          if (language === 'English') {
            setBriefing(fullContent);
          }
        },
        (sources) => {
          setBriefingSources(prev => {
            const combined = [...prev, ...sources];
            // Unique sources by URL
            return Array.from(new Map(combined.map(s => [s.url, s])).values());
          });
        }
      );
      setOriginalBriefing(fullContent);
    } catch (e) {
      console.error(e);
      setBriefing(formatError(e));
    } finally {
      setGeneratingBriefing(false);
    }
  };

  const handleGenerateArc = async () => {
    setGeneratingArc(true);
    try {
      const result = await generateStoryArc(arcTopic);
      setStoryArc(result);
    } catch (e) {
      console.error(e);
    } finally {
      setGeneratingArc(false);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim() || isChatLoading) return;

    const userMessage = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsChatLoading(true);

    try {
      const history = chatMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));
      
      const response = await chatWithNews(userMessage, history);
      setChatMessages(prev => [...prev, { role: 'model', text: response.text, sources: response.sources }]);
    } catch (e) {
      console.error(e);
      setChatMessages(prev => [...prev, { role: 'model', text: "Sorry, I encountered an error. Please try again." }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  const handleEntityClick = async (entity: string) => {
    setSelectedEntity(entity);
    setLoadingEntityDetails(true);
    setEntityDetails(null);
    try {
      const details = await getEntityDetails(entity);
      setEntityDetails(details);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingEntityDetails(false);
    }
  };

  const handleStartStory = async (topicOverride?: string) => {
    if (!profile) return;
    const topic = topicOverride || storyTopic;
    if (topicOverride) setStoryTopic(topicOverride);
    
    setIsGeneratingStory(true);
    setCurrentStory(null);
    if (topicOverride) setActiveTab('story');
    
    try {
      const result = await generateStorySegment(profile.persona, topic);
      const imageUrl = await generateAndCacheImage(result.imagePrompt || topic);
      setCurrentStory({ ...result, imageUrl: imageUrl || getDefaultImage(result.imagePrompt || topic) });
    } catch (e) {
      console.error(e);
    } finally {
      setIsGeneratingStory(false);
    }
  };

  const handleRegenerateStoryImage = async () => {
    if (!currentStory?.imagePrompt) return;
    setIsRegeneratingImage(true);
    try {
      const imageUrl = await generateAndCacheImage(currentStory.imagePrompt || storyTopic);
      if (imageUrl) {
        setCurrentStory(prev => prev ? { ...prev, imageUrl } : null);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsRegeneratingImage(false);
    }
  };

  const handleListen = async (text: string, id: string) => {
    if (activeAudioId === id && isPlaying) {
      audio?.pause();
      setIsPlaying(false);
      return;
    }

    if (activeAudioId === id && !isPlaying) {
      if (audio) {
        audio.play();
        setIsPlaying(true);
        return;
      }
      // If audio is null but we're trying to resume, request TTS again
    }

    // Stop current audio if any
    if (audio) {
      audio.pause();
    }

    setIsGeneratingSpeech(true);
    setActiveAudioId(id);
    try {
      const audioUrl = await generateSpeech(text);
      if (audioUrl) {
        // Handle Web Speech API format
        if (audioUrl.startsWith('ws-api:///')) {
          const decodedText = decodeURIComponent(audioUrl.replace('ws-api:///', ''));
          setIsPlaying(true);
          try {
            await speakText(decodedText);
          } finally {
            setIsPlaying(false);
            setActiveAudioId(null);
          }
        } else {
          // Handle regular audio data URL or blob URL
          const newAudio = new Audio(audioUrl);
          let audioLoadFailed = false;

          newAudio.onerror = async (e) => {
            console.warn('⚠️ Audio file failed to load, falling back to Web Speech API:', e);
            audioLoadFailed = true;
            
            // Fallback to Web Speech API
            try {
              const decodedText = text;
              await speakText(decodedText);
            } catch (speechError) {
              console.error('Web Speech API also failed:', speechError);
            } finally {
              setIsPlaying(false);
              setActiveAudioId(null);
              setIsGeneratingSpeech(false);
            }
          };

          newAudio.onended = () => {
            if (!audioLoadFailed) {
              setIsPlaying(false);
              setActiveAudioId(null);
              setIsGeneratingSpeech(false);
            }
          };

          newAudio.onloadstart = () => {
            console.log('🔊 Loading audio...');
          };

          newAudio.oncanplay = () => {
            console.log('✅ Audio ready to play');
          };

          setAudio(newAudio);
          setIsPlaying(true);
          
          newAudio.play().catch(err => {
            console.warn('⚠️ Audio play error, falling back to Web Speech API:', err);
            audioLoadFailed = true;
            
            // Fallback to Web Speech API
            speakText(text).catch(e => {
              console.error('Web Speech API fallback failed:', e);
            }).finally(() => {
              setIsPlaying(false);
              setActiveAudioId(null);
              setIsGeneratingSpeech(false);
            });
          });
        }
      } else {
        console.warn('⚠️ generateSpeech returned null, using Web Speech API');
        setIsPlaying(true);
        try {
          await speakText(text);
        } finally {
          setIsPlaying(false);
          setActiveAudioId(null);
          setIsGeneratingSpeech(false);
        }
      }
    } catch (e) {
      console.error('Speech generation error:', e);
      setIsGeneratingSpeech(false);
      setActiveAudioId(null);
    }
  };

  const handleGeneratePodcast = async () => {
    if (!profile) return;
    setIsGeneratingPodcast(true);
    setPodcastAudio(null);
    try {
      console.log('📝 Generating podcast script...');
      const script = await generatePodcastScript(profile.interests, profile.persona, podcastTopic || undefined);
      
      console.log('🎙️  Generating podcast audio...');
      const audioUrl = await generateMultiSpeakerPodcast(script);
      
      if (audioUrl) {
        console.log('✅ Podcast audio generated successfully');
        // Podcast audio is already in the correct format (data URL or ws-api://)
        setPodcastAudio(audioUrl);
      } else {
        console.warn('⚠️  Podcast audio generation failed, using mock fallback');
        // Fallback: Keep audio as null and show message to user
        setPodcastAudio(null);
      }
    } catch (e) {
      console.error('❌ Podcast generation error:', e);
      setPodcastAudio(null);
    } finally {
      setIsGeneratingPodcast(false);
    }
  };

  const AudioPlayer = ({ src }: { src: string | null }) => {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [useWebSpeech, setUseWebSpeech] = useState(false);

    // Check if this is a Web Speech API URL
    useEffect(() => {
      if (src?.startsWith('ws-api:///')) {
        setUseWebSpeech(true);
      } else {
        setUseWebSpeech(false);
      }
    }, [src]);

    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;

      const updateTime = () => setCurrentTime(audio.currentTime);
      const updateDuration = () => setDuration(audio.duration);
      const handleEnded = () => setIsPlaying(false);
      const handleError = () => {
        console.error('Audio element error');
        setError('Failed to load audio');
      };

      audio.addEventListener('timeupdate', updateTime);
      audio.addEventListener('loadedmetadata', updateDuration);
      audio.addEventListener('ended', handleEnded);
      audio.addEventListener('error', handleError);

      return () => {
        audio.removeEventListener('timeupdate', updateTime);
        audio.removeEventListener('loadedmetadata', updateDuration);
        audio.removeEventListener('ended', handleEnded);
        audio.removeEventListener('error', handleError);
      };
    }, []);

    const togglePlay = async () => {
      if (!src) {
        setError('No audio available');
        return;
      }

      if (useWebSpeech) {
        // Use Web Speech API
        const text = decodeURIComponent(src.replace('ws-api:///', ''));
        try {
          setIsPlaying(true);
          await speakText(text);
          setIsPlaying(false);
        } catch (e) {
          console.error('Web Speech API failed:', e);
          setError('Audio playback not available');
          setIsPlaying(false);
        }
      } else {
        // Use regular audio element
        if (audioRef.current) {
          try {
            if (isPlaying) {
              audioRef.current.pause();
            } else {
              // Wait for audio to be loadable
              const promise = audioRef.current.play();
              if (promise !== undefined) {
                promise.catch((err) => {
                  console.error('Audio play error:', err);
                  setError('Failed to play audio');
                });
              }
            }
            setIsPlaying(!isPlaying);
          } catch (e) {
            console.error('Playback error:', e);
            setError('Failed to play audio');
          }
        }
      }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
      const time = parseFloat(e.target.value);
      if (audioRef.current) {
        audioRef.current.currentTime = time;
        setCurrentTime(time);
      }
    };

    const formatTime = (time: number) => {
      const minutes = Math.floor(time / 60);
      const seconds = Math.floor(time % 60);
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    };

    if (!src) {
      return (
        <div className="w-full bg-gray-50 p-4 rounded-2xl text-center text-sm text-gray-400">
          ⚠️ Audio generation currently unavailable. Please try again.
        </div>
      );
    }

    return (
      <div className="w-full bg-gray-50 p-6 rounded-2xl space-y-4">
        {!useWebSpeech && <audio ref={audioRef} src={src} />}
        {error && <div className="text-xs text-red-500 font-semibold">{error}</div>}
        <div className="flex items-center gap-4">
          <button 
            onClick={togglePlay}
            className="w-12 h-12 bg-orange-500 text-white rounded-full flex items-center justify-center hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20"
          >
            {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6 ml-1" />}
          </button>
          <div className="flex-1 space-y-1">
            {useWebSpeech ? (
              <div className="text-[10px] font-bold text-orange-500 uppercase tracking-widest">
                🎤 Browser Voice (No Audio File)
              </div>
            ) : (
              <>
                <input 
                  type="range" 
                  min="0" 
                  max={duration || 0} 
                  value={currentTime} 
                  onChange={handleSeek}
                  className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-orange-500"
                />
                <div className="flex justify-between text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  const VoiceNote = ({ text, id, className = "", label = "Listen to News" }: { text: string, id: string, className?: string, label?: string }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        handleListen(text, id);
      }}
      disabled={isGeneratingSpeech && activeAudioId === id}
      className={`flex items-center gap-2 px-3 py-1.5 bg-orange-50 text-orange-600 rounded-lg text-xs font-bold hover:bg-orange-100 transition-all disabled:opacity-50 ${className}`}
    >
      {isGeneratingSpeech && activeAudioId === id ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : activeAudioId === id && isPlaying ? (
        <Pause className="w-3 h-3" />
      ) : (
        <Volume2 className="w-3 h-3" />
      )}
      {activeAudioId === id && isPlaying ? 'Pause Voice Note' : label}
    </button>
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white transition-colors duration-300">
        <Loader2 className="w-8 h-8 text-orange-500 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center p-6 transition-colors duration-300">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center max-w-2xl"
        >
          <div className="inline-block px-4 py-1.5 bg-orange-50 text-orange-600 rounded-full text-xs font-bold tracking-widest uppercase mb-6">
            The Future of Business News
          </div>
          <h1 className="text-6xl md:text-8xl font-black text-gray-900 tracking-tighter mb-8 leading-[0.9]">
            AURA <span className="text-orange-500">NEWS.</span>
          </h1>
          <p className="text-xl text-gray-500 mb-12 leading-relaxed">
            Experience news that thinks with you. Personalized intelligence briefings, 
            visual story arcs, and real-time vernacular synthesis.
          </p>
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="px-10 py-5 bg-gray-900 text-white rounded-2xl font-bold text-lg hover:bg-gray-800 transition-all shadow-2xl shadow-gray-200 flex items-center mx-auto disabled:opacity-50"
          >
            {isLoggingIn ? (
              <>Connecting... <Loader2 className="ml-3 w-5 h-5 animate-spin" /></>
            ) : (
              <>Connect with Google <ArrowRight className="ml-3 w-5 h-5" /></>
            )}
          </button>
        </motion.div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="min-h-screen bg-white p-6 md:p-12 transition-colors duration-300">
        <Onboarding onComplete={handleOnboardingComplete} />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-white flex flex-col md:flex-row transition-colors duration-300">
        {/* Sidebar */}
        <aside className="w-full md:w-72 bg-white border-r border-gray-200 p-6 flex flex-col transition-colors duration-300">
          <div className="flex items-center gap-2 mb-12">
            <div className="w-8 h-8 bg-orange-500 rounded-lg flex items-center justify-center">
              <Newspaper className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-black tracking-tighter">AURA NEWS</span>
          </div>

          <nav className="flex-1 space-y-2">
            {[
              { id: 'feed', label: 'My Newsroom', icon: LayoutDashboard },
              { id: 'navigator', label: 'News Navigator', icon: Navigation },
              { id: 'chat', label: 'News Chat', icon: MessageSquare },
              { id: 'arcs', label: 'Story Arcs', icon: TrendingUp },
              { id: 'story', label: 'Story Mode', icon: BookOpen },
              { id: 'podcast', label: 'Podcast Mode', icon: Headphones },
            ].map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-semibold transition-all ${
                  activeTab === item.id 
                    ? 'bg-orange-50 text-orange-600' 
                    : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <item.icon className="w-5 h-5" />
                {item.label}
              </button>
            ))}
          </nav>

          <div className="mt-auto pt-6 border-t border-gray-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-gray-100 rounded-full flex items-center justify-center">
                <User className="w-5 h-5 text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-gray-900 truncate">{profile.displayName}</p>
                <p className="text-xs text-gray-500 capitalize">{profile.persona}</p>
              </div>
            </div>
            <button 
              onClick={() => signOut(auth)}
              className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-500 font-semibold hover:bg-red-50 rounded-lg transition-all"
            >
              <LogOut className="w-4 h-4" /> Sign Out
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 bg-white p-6 md:p-12 overflow-y-auto transition-colors duration-300">
          {/* Top Bar */}
          <div className="flex items-center justify-between mb-12">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 px-4 py-2 bg-gray-50 border border-gray-200 rounded-xl shadow-sm transition-colors duration-300">
                <Globe className="w-4 h-4 text-gray-400" />
                <select 
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  className="bg-transparent border-none text-xs font-black uppercase tracking-widest text-gray-500 focus:ring-0 cursor-pointer"
                >
                  {ALL_LANGS.map(lang => (
                    <option key={lang} value={lang} className="bg-white">{lang}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex items-center gap-4">
              {/* Navigation controls */}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {activeTab === 'feed' && (
              <motion.div 
                key="feed"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-4xl mx-auto"
              >
                {selectedArticle ? (
                  <div className="space-y-8">
                    <button 
                      onClick={() => setSelectedArticle(null)}
                      className="flex items-center text-orange-600 font-bold hover:text-orange-700 transition-colors mb-4"
                    >
                      <ArrowRight className="w-4 h-4 mr-2 rotate-180" /> Back to Newsroom
                    </button>
                    
                    {loadingArticle ? (
                      <div className="flex flex-col items-center justify-center h-[400px] text-gray-400">
                        <Loader2 className="w-12 h-12 animate-spin mb-4" />
                        <p>Generating deep intelligence briefing...</p>
                      </div>
                    ) : (
                      <div className="space-y-8">
                        {articleImage && (
                          <motion.div 
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="w-full h-[300px] md:h-[400px] rounded-[2rem] overflow-hidden shadow-lg border border-gray-100"
                          >
                            <img 
                              src={articleImage} 
                              alt="Article Visual" 
                              referrerPolicy="no-referrer"
                              className="w-full h-full object-cover"
                            />
                          </motion.div>
                        )}
                    <div className="bg-white dark:bg-[#141414] p-8 md:p-12 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 relative">
                      <div className="flex justify-end mb-6">
                        <VoiceNote text={articleContent} id="article" />
                      </div>
                      {translating && (
                        <div className="absolute inset-0 bg-white/50 dark:bg-black/50 backdrop-blur-[2px] z-10 flex items-center justify-center rounded-[2rem]">
                          <div className="flex items-center gap-2 bg-white dark:bg-[#141414] px-4 py-2 rounded-full shadow-lg border border-gray-100 dark:border-gray-800">
                            <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
                            <span className="text-xs font-bold dark:text-white">Translating to {language}...</span>
                          </div>
                        </div>
                      )}
                      <motion.div 
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="prose prose-orange dark:prose-invert max-w-none"
                      >
                        <Markdown
                          components={{
                            a: ({ node, ...props }) => {
                              if (props.href?.startsWith('entity:')) {
                                const entity = props.href.replace('entity:', '');
                                return (
                                  <button
                                    onClick={() => handleEntityClick(entity)}
                                    className="text-orange-600 dark:text-orange-400 font-bold hover:underline decoration-orange-300 underline-offset-4"
                                  >
                                    {props.children}
                                  </button>
                                );
                              }
                              return <a {...props} target="_blank" rel="noopener noreferrer" />;
                            }
                          }}
                        >
                          {articleContent}
                        </Markdown>
                      </motion.div>
                    </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="mb-12">
                      <h2 className="text-5xl font-black text-gray-900 dark:text-white tracking-tight mb-4 leading-none">My Newsroom.</h2>
                      <p className="text-gray-500 dark:text-gray-400 text-lg">Personalized intelligence based on your interests: <span className="text-orange-600 dark:text-orange-400 font-bold">{profile.interests.join(', ')}</span></p>
                    </div>

                    {loadingFeed ? (
                      <div className="flex flex-col items-center justify-center h-[400px] text-gray-400">
                        <Loader2 className="w-12 h-12 animate-spin mb-4" />
                        <p>Synthesizing your personalized feed...</p>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-6">
                        {feed.map((item, i) => {
                          const [title, ...rest] = item.split(':');
                          return (
                            <motion.div 
                              key={i}
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: i * 0.1 }}
                              onClick={() => handleArticleClick(item)}
                              className="bg-white dark:bg-[#141414] p-8 rounded-3xl shadow-sm border border-gray-100 dark:border-gray-800 hover:border-orange-200 dark:hover:border-orange-500/50 transition-all cursor-pointer group"
                            >
                              <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-3 group-hover:text-orange-600 dark:group-hover:text-orange-400 transition-colors">{title}</h3>
                              <p className="text-gray-600 dark:text-gray-400 leading-relaxed mb-6">{rest.join(':')}</p>
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-black uppercase tracking-widest text-orange-500 bg-orange-50 dark:bg-orange-500/10 px-3 py-1 rounded-full">
                                  {profile.persona} Insight
                                </span>
                                <div className="flex items-center gap-4">
                                  <VoiceNote text={rest.join(':')} id={`feed-${i}`} />
                                  <span className="text-sm font-bold text-orange-600 dark:text-orange-400 opacity-0 group-hover:opacity-100 transition-opacity flex items-center">
                                    Read Full Briefing <ArrowRight className="w-4 h-4 ml-1" />
                                  </span>
                                  <button className="text-gray-400 hover:text-orange-500 transition-colors">
                                    <Share2 className="w-5 h-5" />
                                  </button>
                                </div>
                              </div>
                            </motion.div>
                          );
                        })}
                        <button 
                          onClick={fetchPersonalizedFeed}
                          className="mt-8 py-4 border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-3xl text-gray-400 font-bold hover:border-orange-200 dark:hover:border-orange-500/50 hover:text-orange-500 transition-all"
                        >
                          Refresh Feed
                        </button>
                      </div>
                    )}
                  </>
                )}
              </motion.div>
            )}

            {activeTab === 'navigator' && (
              <motion.div 
                key="navigator"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-4xl mx-auto"
              >
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
                  <div>
                    <h2 className="text-5xl font-black text-gray-900 dark:text-white tracking-tight mb-4 leading-none">News Navigator.</h2>
                    <p className="text-gray-500 dark:text-gray-400 text-lg">Interactive intelligence briefings synthesized for your persona.</p>
                  </div>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={briefingTopic}
                      onChange={(e) => setBriefingTopic(e.target.value)}
                      placeholder="Enter a topic or news link (URL)..."
                      className="px-4 py-3 bg-white dark:bg-[#141414] border border-gray-200 dark:border-gray-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/20 w-64 dark:text-white"
                    />
                    <button 
                      onClick={handleGenerateBriefing}
                      disabled={generatingBriefing}
                      className="px-6 py-3 bg-orange-500 text-white rounded-xl font-bold hover:bg-orange-600 transition-all disabled:opacity-50 flex items-center"
                    >
                      {generatingBriefing ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Synthesize'}
                    </button>
                  </div>
                </div>

                {briefing ? (
                  <div className="space-y-8">
                    {briefingImage && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="w-full h-[300px] md:h-[400px] rounded-[2rem] overflow-hidden shadow-lg border border-gray-100 dark:border-gray-800"
                      >
                        <img 
                          src={briefingImage} 
                          alt="Briefing Visual" 
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      </motion.div>
                    )}
                    <div className="flex justify-end gap-3">
                      <VoiceNote 
                        text={briefing} 
                        id="briefing" 
                        label="Listen to Briefing"
                        className="px-6 py-3 rounded-xl shadow-sm text-base"
                      />
                      <button 
                        onClick={() => handleStartStory(briefingTopic)}
                        className="flex items-center gap-2 px-6 py-3 bg-orange-100 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 rounded-xl font-bold hover:bg-orange-200 dark:hover:bg-orange-500/20 transition-all shadow-sm"
                      >
                        <BookOpen className="w-5 h-5" />
                        Convert to Story
                      </button>
                    </div>
                    <div className="bg-white dark:bg-[#141414] p-8 md:p-12 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 relative">
                      {translating && (
                        <div className="absolute inset-0 bg-white/50 dark:bg-black/50 backdrop-blur-[2px] z-10 flex items-center justify-center rounded-[2rem]">
                          <div className="flex items-center gap-2 bg-white dark:bg-[#141414] px-4 py-2 rounded-full shadow-lg border border-gray-100 dark:border-gray-800">
                            <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
                            <span className="text-xs font-bold dark:text-white">Translating to {language}...</span>
                          </div>
                        </div>
                      )}
                      <div className="prose prose-orange dark:prose-invert max-w-none">
                        <Markdown
                          components={{
                            a: ({ node, ...props }) => {
                              if (props.href?.startsWith('entity:')) {
                                const entity = props.href.replace('entity:', '');
                                return (
                                  <button
                                    onClick={() => handleEntityClick(entity)}
                                    className="text-orange-600 dark:text-orange-400 font-bold hover:underline decoration-orange-300 underline-offset-4"
                                  >
                                    {props.children}
                                  </button>
                                );
                              }
                              return <a {...props} target="_blank" rel="noopener noreferrer" />;
                            }
                          }}
                        >
                          {briefing}
                        </Markdown>
                      </div>

                      {briefingSources.length > 0 && !translating && (
                        <div className="mt-12 pt-8 border-t border-gray-100 dark:border-gray-800">
                          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-4">Intelligence Sources</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {briefingSources.map((source, i) => (
                              <a 
                                key={i} 
                                href={source.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-100 dark:border-gray-800 hover:border-orange-200 dark:hover:border-orange-500/50 hover:bg-orange-50/30 dark:hover:bg-orange-500/10 transition-all group"
                              >
                                <div className="w-8 h-8 bg-white dark:bg-white/10 rounded-lg flex items-center justify-center border border-gray-100 dark:border-gray-800 group-hover:border-orange-100 dark:group-hover:border-orange-500/50">
                                  <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-orange-500" />
                                </div>
                                <span className="text-xs font-bold text-gray-600 dark:text-gray-400 truncate group-hover:text-gray-900 dark:group-hover:text-white">{source.title}</span>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="h-[400px] bg-gray-50 dark:bg-white/5 rounded-[2rem] border-2 border-dashed border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center text-gray-400">
                    <Navigation className="w-12 h-12 mb-4 opacity-20" />
                    <p>Enter a topic to generate your interactive briefing.</p>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'arcs' && (
              <motion.div 
                key="arcs"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-5xl mx-auto"
              >
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
                  <div>
                    <h2 className="text-5xl font-black text-gray-900 dark:text-white tracking-tight mb-4 leading-none">Story Arcs.</h2>
                    <p className="text-gray-500 dark:text-gray-400 text-lg">Visual narratives mapping players, sentiment, and predictions.</p>
                  </div>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={arcTopic}
                      onChange={(e) => setArcTopic(e.target.value)}
                      className="px-4 py-3 bg-white dark:bg-[#141414] border border-gray-200 dark:border-gray-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/20 w-64 dark:text-white"
                    />
                    <button 
                      onClick={handleGenerateArc}
                      disabled={generatingArc}
                      className="px-6 py-3 bg-gray-900 dark:bg-white dark:text-black text-white rounded-xl font-bold hover:bg-gray-800 dark:hover:bg-gray-200 transition-all disabled:opacity-50"
                    >
                      {generatingArc ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Map Story'}
                    </button>
                  </div>
                </div>

                {storyArc ? (
                  <div className="space-y-8">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                      <div className="bg-white dark:bg-[#141414] p-8 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800">
                        <h3 className="text-xl font-bold mb-8 flex items-center gap-2 dark:text-white">
                          <TrendingUp className="w-5 h-5 text-orange-500" /> Sentiment Timeline
                        </h3>
                        <div style={{ height: '300px', width: '100%' }}>
                          {storyArc.timeline && storyArc.timeline.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%" minHeight={300}>
                              <AreaChart data={storyArc.timeline}>
                                <defs>
                                  <linearGradient id="colorSentiment" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.1}/>
                                    <stop offset="95%" stopColor="#f97316" stopOpacity={0}/>
                                  </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme === 'dark' ? '#1f2937' : '#f3f4f6'} />
                                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} />
                                <YAxis domain={[-1, 1]} axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} />
                                <Tooltip 
                                  contentStyle={{ 
                                    borderRadius: '12px', 
                                    border: 'none', 
                                    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                                    backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
                                    color: theme === 'dark' ? '#ffffff' : '#000000'
                                  }}
                                />
                                <Area type="monotone" dataKey="sentiment" stroke="#f97316" strokeWidth={3} fillOpacity={1} fill="url(#colorSentiment)" />
                              </AreaChart>
                            </ResponsiveContainer>
                          ) : (
                            <div className="h-full flex items-center justify-center text-gray-400 text-sm italic">Insufficient data points to map the sentiment timeline.</div>
                          )}
                        </div>
                      </div>

                      <div className="bg-white dark:bg-[#141414] p-8 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800">
                        <h3 className="text-xl font-bold mb-8 flex items-center gap-2 dark:text-white">
                          <TrendingUp className="w-5 h-5 text-blue-500" /> Stock Price / Valuation
                        </h3>
                        <div style={{ height: '300px', width: '100%' }}>
                          {storyArc.timeline && storyArc.timeline.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%" minHeight={300}>
                              <LineChart data={storyArc.timeline}>
                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={theme === 'dark' ? '#1f2937' : '#f3f4f6'} />
                                <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} />
                                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: '#9ca3af' }} />
                                <Tooltip 
                                  contentStyle={{ 
                                    borderRadius: '12px', 
                                    border: 'none', 
                                    boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)',
                                    backgroundColor: theme === 'dark' ? '#1f2937' : '#ffffff',
                                    color: theme === 'dark' ? '#ffffff' : '#000000'
                                  }}
                                />
                                <Line type="monotone" dataKey="price" stroke="#3b82f6" strokeWidth={3} dot={{ r: 4, fill: '#3b82f6', strokeWidth: 2, stroke: '#fff' }} activeDot={{ r: 6 }} />
                              </LineChart>
                            </ResponsiveContainer>
                          ) : (
                            <div className="h-full flex items-center justify-center text-gray-400 text-sm italic">Insufficient data points to map the price fluctuations.</div>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      <div className="bg-white dark:bg-[#141414] p-8 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800">
                        <h3 className="text-xl font-bold mb-6 flex items-center gap-2 dark:text-white">
                          <User className="w-5 h-5 text-orange-500" /> Key Players
                        </h3>
                        <div className="flex flex-wrap gap-2">
                          {(storyArc.keyPlayers || []).map((player, i) => (
                            <span key={i} className="px-4 py-2 bg-gray-50 dark:bg-white/5 text-gray-700 dark:text-gray-300 rounded-full text-sm font-medium border border-gray-100 dark:border-gray-800">
                              {player}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="bg-white dark:bg-[#141414] p-8 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800">
                        <h3 className="text-xl font-bold mb-6 flex items-center gap-2 dark:text-white">
                          <TrendingUp className="w-5 h-5 text-orange-500" /> Predictions
                        </h3>
                        <ul className="space-y-4">
                          {(storyArc.predictions || []).map((pred, i) => (
                            <li key={i} className="flex gap-3 text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                              <div className="w-1.5 h-1.5 bg-orange-500 rounded-full mt-1.5 shrink-0" />
                              {pred}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="h-[400px] bg-gray-50 dark:bg-white/5 rounded-[2rem] border-2 border-dashed border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center text-gray-400">
                    <TrendingUp className="w-12 h-12 mb-4 opacity-20" />
                    <p>Select a major business story to track its arc.</p>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'story' && (
              <motion.div 
                key="story"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-4xl mx-auto"
              >
                <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-12">
                  <div>
                    <h2 className="text-5xl font-black text-gray-900 dark:text-white tracking-tight mb-4 leading-none">News Stories.</h2>
                    <p className="text-gray-500 dark:text-gray-400 text-lg">Turn any news topic into a short, engaging visual narrative.</p>
                  </div>
                  <div className="flex gap-2">
                    <input 
                      type="text" 
                      value={storyTopic}
                      onChange={(e) => setStoryTopic(e.target.value)}
                      placeholder="Enter a news topic..."
                      className="px-4 py-3 bg-white dark:bg-[#141414] border border-gray-200 dark:border-gray-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/20 w-64 dark:text-white"
                    />
                    <button 
                      onClick={() => handleStartStory()}
                      disabled={isGeneratingStory}
                      className="px-6 py-3 bg-orange-500 text-white rounded-xl font-bold hover:bg-orange-600 transition-all disabled:opacity-50 flex items-center"
                    >
                      {isGeneratingStory ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Create Story'}
                    </button>
                  </div>
                </div>

                {currentStory ? (
                  <div className="space-y-8">
                    {currentStory.imageUrl && (
                      <motion.div 
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="w-full h-[300px] md:h-[400px] rounded-[2rem] overflow-hidden shadow-lg border border-gray-100 dark:border-gray-800 relative group"
                      >
                        <img 
                          src={currentStory.imageUrl} 
                          alt="Story Visual" 
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <button 
                            onClick={handleRegenerateStoryImage}
                            disabled={isRegeneratingImage}
                            className="px-6 py-3 bg-white text-black rounded-xl font-bold hover:bg-gray-100 transition-all flex items-center gap-2"
                          >
                            {isRegeneratingImage ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                            Regenerate Image
                          </button>
                        </div>
                      </motion.div>
                    )}
                    <div className="bg-white dark:bg-[#141414] p-8 md:p-12 rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800">
                      <div className="flex justify-end mb-6">
                        <VoiceNote text={currentStory.story} id="story" />
                      </div>
                      <div className="prose prose-orange dark:prose-invert max-w-none space-y-4">
                        {currentStory.story.split('\n').filter(line => line.trim()).map((line, i) => (
                          <p key={i} className={`text-xl md:text-2xl leading-relaxed ${i === 0 ? 'font-black text-gray-900 dark:text-white' : 'text-gray-600 dark:text-gray-400'} ${line.toLowerCase().startsWith('why it matters') ? 'pt-6 border-t border-gray-100 dark:border-gray-800 font-bold text-orange-600 dark:text-orange-400' : ''}`}>
                            {line}
                          </p>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="h-[400px] bg-gray-50 dark:bg-white/5 rounded-[2rem] border-2 border-dashed border-gray-200 dark:border-gray-800 flex flex-col items-center justify-center text-gray-400">
                    <BookOpen className="w-12 h-12 mb-4 opacity-20" />
                    <p>Enter a topic to see it transformed into a short story.</p>
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'podcast' && (
              <motion.div 
                key="podcast"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.05 }}
                className="max-w-4xl mx-auto text-center"
              >
                <div className="mb-12">
                  <h2 className="text-6xl font-black text-gray-900 dark:text-white tracking-tight mb-6 leading-none">Podcast Mode.</h2>
                  <p className="text-gray-500 dark:text-gray-400 text-xl max-w-2xl mx-auto">
                    Sit back and listen. We'll synthesize your personalized news feed into a conversational podcast with two AI hosts.
                  </p>
                </div>

                <div className="bg-white dark:bg-[#141414] p-12 rounded-[3rem] shadow-2xl border border-gray-100 dark:border-gray-800 relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-orange-500 to-red-500" />
                  
                  <div className="flex flex-col items-center gap-8 py-12">
                    <div className="relative">
                      <div className="w-32 h-32 bg-orange-500 rounded-full flex items-center justify-center shadow-2xl shadow-orange-500/40 relative z-10">
                        <Headphones className="w-16 h-16 text-white" />
                      </div>
                      {isGeneratingPodcast && (
                        <div className="absolute inset-0 w-32 h-32 bg-orange-500 rounded-full animate-ping opacity-20" />
                      )}
                    </div>

                    {podcastAudio ? (
                      <div className="w-full space-y-8">
                        <div className="text-center space-y-2">
                          <p className="text-orange-600 dark:text-orange-400 font-black uppercase tracking-widest text-xs">Intelligence Briefing</p>
                          <h3 className="text-2xl font-bold text-gray-900 dark:text-white">
                            {podcastTopic ? `Deep Dive: ${podcastTopic}` : 'Your Daily Intelligence Briefing'}
                          </h3>
                        </div>
                        
                        <AudioPlayer src={podcastAudio} />

                        <div className="flex flex-col items-center gap-4">
                          <button 
                            onClick={handleGeneratePodcast}
                            className="flex items-center gap-2 text-gray-400 hover:text-orange-500 font-bold transition-colors text-sm"
                          >
                            <Loader2 className={`w-4 h-4 ${isGeneratingPodcast ? 'animate-spin' : 'hidden'}`} />
                            Regenerate Podcast
                          </button>
                          
                          <div className="w-full max-w-sm">
                            <input 
                              type="text"
                              placeholder="Change topic (e.g. Future of Energy)"
                              value={podcastTopic}
                              onChange={(e) => setPodcastTopic(e.target.value)}
                              className="w-full px-4 py-2 bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-gray-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/20"
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-8 w-full max-w-md">
                        <div className="space-y-4">
                          <p className="text-gray-500 dark:text-gray-400 font-medium">
                            {isGeneratingPodcast ? 'Synthesizing script and voices...' : 'What would you like to hear about today?'}
                          </p>
                          {!isGeneratingPodcast && (
                            <input 
                              type="text"
                              placeholder="Enter a specific topic or leave blank for daily briefing"
                              value={podcastTopic}
                              onChange={(e) => setPodcastTopic(e.target.value)}
                              className="w-full px-6 py-4 bg-gray-50 dark:bg-white/5 border border-gray-100 dark:border-gray-800 rounded-2xl text-lg focus:outline-none focus:ring-2 focus:ring-orange-500/20 text-center"
                            />
                          )}
                        </div>
                        <button 
                          onClick={handleGeneratePodcast}
                          disabled={isGeneratingPodcast}
                          className="w-full py-5 bg-orange-500 text-white rounded-[2rem] font-black text-xl hover:bg-orange-600 transition-all shadow-xl shadow-orange-500/20 disabled:opacity-50 flex items-center justify-center gap-3"
                        >
                          {isGeneratingPodcast ? (
                            <>Synthesizing... <Loader2 className="w-6 h-6 animate-spin" /></>
                          ) : (
                            <>Start Podcast <Play className="w-6 h-6" /></>
                          )}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-8 mt-12 pt-12 border-t border-gray-100 dark:border-gray-800">
                    <div className="text-left">
                      <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Host 1</p>
                      <p className="text-lg font-bold text-gray-900 dark:text-white">Alex</p>
                      <p className="text-sm text-gray-500">The Analytical Mind</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-black uppercase tracking-widest text-gray-400 mb-2">Host 2</p>
                      <p className="text-lg font-bold text-gray-900 dark:text-white">Sam</p>
                      <p className="text-sm text-gray-500">The Enthusiast</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
            {activeTab === 'chat' && (
              <motion.div 
                key="chat"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-5xl mx-auto h-[calc(100vh-150px)] flex flex-col"
              >
                <div className="mb-4">
                  <h2 className="text-5xl font-black text-gray-900 dark:text-white tracking-tight mb-4 leading-none">News Chat.</h2>
                  <p className="text-gray-500 dark:text-gray-400 text-lg">Ask about the latest business news and market trends.</p>
                </div>

                <div className="flex-1 bg-white dark:bg-[#141414] rounded-[2rem] shadow-sm border border-gray-100 dark:border-gray-800 flex flex-col overflow-hidden">
                  <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {chatMessages.length === 0 && (
                      <div className="h-full flex flex-col items-center justify-center text-gray-400">
                        <MessageSquare className="w-12 h-12 mb-4 opacity-20" />
                        <p>Start a conversation about the latest news.</p>
                      </div>
                    )}
                    {chatMessages.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[80%] p-4 rounded-2xl ${msg.role === 'user' ? 'bg-orange-500 text-white' : 'bg-gray-50 dark:bg-white/5 text-gray-900 dark:text-white border border-gray-100 dark:border-gray-800'}`}>
                          <div className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed">
                            <Markdown>{msg.text}</Markdown>
                          </div>
                          {msg.sources && msg.sources.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-gray-200/50 dark:border-gray-700/50">
                              <p className="text-[10px] font-black uppercase tracking-wider mb-2 opacity-50">Sources</p>
                              <div className="flex flex-wrap gap-2">
                                {msg.sources.map((source, si) => (
                                  <a 
                                    key={si} 
                                    href={source.url} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-[10px] bg-white/20 dark:bg-white/10 hover:bg-white/30 dark:hover:bg-white/20 px-2 py-1 rounded-md transition-colors truncate max-w-[150px]"
                                  >
                                    {source.title}
                                  </a>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {isChatLoading && (
                      <div className="flex justify-start">
                        <div className="bg-gray-50 dark:bg-white/5 p-4 rounded-2xl border border-gray-100 dark:border-gray-800 flex items-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
                          <span className="text-sm text-gray-500 dark:text-gray-400">Searching for news...</span>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-black/20">
                    <div className="flex gap-2">
                      <input 
                        type="text" 
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                        placeholder="Ask about the latest news..."
                        className="flex-1 px-4 py-3 bg-white dark:bg-[#141414] border border-gray-200 dark:border-gray-800 rounded-xl focus:outline-none focus:ring-2 focus:ring-orange-500/20 dark:text-white"
                      />
                      <button 
                        onClick={handleSendMessage}
                        disabled={isChatLoading || !chatInput.trim()}
                        className="px-6 py-3 bg-orange-500 text-white rounded-xl font-bold hover:bg-orange-600 transition-all disabled:opacity-50"
                      >
                        <Send className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        <AnimatePresence>
          {selectedEntity && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="bg-white dark:bg-[#141414] w-full max-w-2xl rounded-[2.5rem] shadow-2xl overflow-hidden flex flex-col max-h-[80vh] border border-gray-100 dark:border-gray-800"
              >
                <div className="p-8 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between bg-gray-50/50 dark:bg-white/5">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-orange-500 mb-1">Entity Insight</p>
                    <h3 className="text-3xl font-black text-gray-900 dark:text-white tracking-tight">{selectedEntity}</h3>
                  </div>
                  <button 
                    onClick={() => setSelectedEntity(null)}
                    className="w-10 h-10 bg-white dark:bg-white/10 rounded-full shadow-sm border border-gray-100 dark:border-gray-800 flex items-center justify-center hover:bg-gray-50 dark:hover:bg-white/20 transition-colors"
                  >
                    <X className="w-5 h-5 text-gray-400" />
                  </button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-8">
                  {loadingEntityDetails ? (
                    <div className="h-40 flex flex-col items-center justify-center text-gray-400">
                      <Loader2 className="w-8 h-8 animate-spin mb-4 text-orange-500" />
                      <p className="text-sm font-medium">Synthesizing deep-dive intelligence...</p>
                    </div>
                  ) : entityDetails ? (
                    <div className="space-y-8">
                      <div className="prose prose-orange dark:prose-invert max-w-none">
                        <Markdown>{entityDetails.text}</Markdown>
                      </div>
                      
                      {entityDetails.sources && entityDetails.sources.length > 0 && (
                        <div className="pt-8 border-t border-gray-100 dark:border-gray-800">
                          <p className="text-xs font-black uppercase tracking-widest text-gray-400 mb-4">Intelligence Sources</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {entityDetails.sources.map((source, i) => (
                              <a 
                                key={i} 
                                href={source.url} 
                                target="_blank" 
                                rel="noopener noreferrer"
                                className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 rounded-xl border border-gray-100 dark:border-gray-800 hover:border-orange-200 dark:hover:border-orange-500/50 hover:bg-orange-50/30 dark:hover:bg-orange-500/10 transition-all group"
                              >
                                <div className="w-8 h-8 bg-white dark:bg-white/10 rounded-lg flex items-center justify-center border border-gray-100 dark:border-gray-800 group-hover:border-orange-100 dark:group-hover:border-orange-500/50">
                                  <ExternalLink className="w-4 h-4 text-gray-400 group-hover:text-orange-500" />
                                </div>
                                <span className="text-xs font-bold text-gray-600 dark:text-gray-400 truncate group-hover:text-gray-900 dark:group-hover:text-white">{source.title}</span>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center text-gray-400 py-12 italic">
                      Failed to load details. Please try again.
                    </div>
                  )}
                </div>
                
                <div className="p-6 bg-gray-50/50 dark:bg-white/5 border-t border-gray-100 dark:border-gray-800 text-center">
                  <button 
                    onClick={() => setSelectedEntity(null)}
                    className="px-8 py-3 bg-gray-900 dark:bg-white dark:text-black text-white rounded-xl font-bold hover:bg-gray-800 dark:hover:bg-gray-200 transition-all"
                  >
                    Close Insight
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </ErrorBoundary>
  );
}
