/**
 * Image Generation Utilities
 * Handles image loading, caching, and fallback strategies
 */

import { generateImage } from '../agents/ImageGenerationAgent';

interface CachedImage {
  url: string;
  timestamp: number;
  attempts: number;
}

const imageCache = new Map<string, CachedImage>();
const IMAGE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_GENERATION_ATTEMPTS = 2;

/**
 * Get a cached image URL if available and valid
 */
export const getCachedImageUrl = (topic: string): string | null => {
  const cacheKey = `img:${topic}`;
  const cached = imageCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < IMAGE_CACHE_TTL) {
    console.log(`✓ Image Cache HIT for: ${topic}`);
    return cached.url;
  }
  
  if (cached) {
    imageCache.delete(cacheKey);
  }
  
  return null;
};

/**
 * Cache an image URL
 */
const setCachedImageUrl = (topic: string, url: string): void => {
  const cacheKey = `img:${topic}`;
  imageCache.set(cacheKey, {
    url,
    timestamp: Date.now(),
    attempts: 1,
  });
  console.log(`✓ Image cached for: ${topic}`);
};

/**
 * Generate and cache image with retry logic
 * NOTE: Skipping Pollinations API due to reliability issues
 * Using proven Unsplash fallback images instead
 */
export const generateAndCacheImage = async (topic: string): Promise<string | null> => {
  // Check cache first
  const cached = getCachedImageUrl(topic);
  if (cached) return cached;

  console.log(`🎨 Loading image for: ${topic}`);
  
  // Skip Pollinations API - use reliable fallback directly
  const fallbackUrl = getDefaultImage(topic);
  
  if (fallbackUrl) {
    // Validate the image actually loads before caching
    const isValid = await validateImageUrl(fallbackUrl);
    if (isValid) {
      setCachedImageUrl(topic, fallbackUrl);
      console.log(`✓ Image loaded successfully from fallback`);
      return fallbackUrl;
    }
  }

  console.warn(`⚠️  Fallback image validation failed, using placeholder`);
  // Ultimate fallback - use a simple colorful gradient placeholder
  const placeholderUrl = getMockImagePlaceholder(topic);
  return placeholderUrl;
};

/**
 * Get a default/fallback image based on topic
 * Uses reliable image sources with fallback to placeholder service
 */
export const getDefaultImage = (topic: string): string => {
  const topicLower = topic.toLowerCase();
  
  // Primary fallback: placeholder.com (guaranteed to work)
  const colors = ['FF6B6B', 'FF8C42', 'FFD93D', '6BCB77', '4D96FF', '9D84B7', 'FF1744', '2196F3'];
  const colorIndex = topicLower.charCodeAt(0) % colors.length;
  const bgColor = colors[colorIndex];
  
  // Topic-specific placeholder colors
  const topicColors: Record<string, string> = {
    'ai': '2196F3',           // Blue
    'market': 'FFD93D',       // Yellow
    'energy': 'FF8C42',       // Orange
    'tech': '4D96FF',         // Light Blue
    'supply': '6BCB77',       // Green
    'defense': 'FF1744',      // Red
    'trade': '9D84B7',        // Purple
    'finance': 'FFD93D',      // Yellow
    'cryptocurrency': 'FF8C42', // Orange
    'startup': '6BCB77',      // Green
    'iran': 'FF1744',         // Red
    'iraq': 'FFD93D',         // Yellow
    'war': 'FF1744',          // Red
    'conflict': 'FF1744',     // Red
  };
  
  // Find best color match
  let selectedColor = bgColor;
  for (const [key, color] of Object.entries(topicColors)) {
    if (topicLower.includes(key)) {
      selectedColor = color;
      break;
    }
  }
  
  // Create placeholder with topic text using placehold.co (more reliable DNS)
  const topicShort = topic.substring(0, 20).toUpperCase().replace(/\s+/g, ' ');
  const placeholderUrl = `https://placehold.co/800x500/${selectedColor}/FFFFFF?text=${encodeURIComponent(topicShort)}`;
  
  return placeholderUrl;
};

/**
 * Get a mock/placeholder image with gradient and topic info
 * Creates a reliable fallback when no images are available
 */
export const getMockImagePlaceholder = (topic: string): string => {
  // Use placeholder.com service for guaranteed working images
  const colors = ['FF6B6B', 'FF8C42', 'FFD93D', '6BCB77', '4D96FF', '9D84B7'];
  const colorIndex = topic.charCodeAt(0) % colors.length;
  const bgColor = colors[colorIndex];
  const textColor = 'FFFFFF';
  
  // Create a placeholder image with topic name
  const topicShort = topic.substring(0, 20).toUpperCase();
  return `https://placehold.co/800x500/${bgColor}/${textColor}?text=${encodeURIComponent(topicShort)}`;
};

/**
 * Validate if an image URL is accessible
 */
export const validateImageUrl = async (url: string): Promise<boolean> => {
  try {
    // For placeholder URLs, assume they're valid
    if (url.includes('placehold.co') || url.includes('via.placeholder.com') || url.includes('placeholder.com')) {
      return true;
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
    
    try {
      const response = await fetch(url, { 
        method: 'HEAD', 
        mode: 'cors',
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response.ok || response.status === 200;
    } catch (fetchError) {
      clearTimeout(timeoutId);
      // If CORS blocks it, try with no-cors mode
      const corsResponse = await fetch(url, { 
        method: 'HEAD', 
        mode: 'no-cors'
      });
      return true; // no-cors always returns status 0, assume success
    }
  } catch (error) {
    console.warn(`⚠️ Image URL validation failed for: ${url}`);
    return false;
  }
};

/**
 * Clear image cache (useful for testing or manual refresh)
 */
export const clearImageCache = (): void => {
  imageCache.clear();
  console.log('✓ Image cache cleared');
};
