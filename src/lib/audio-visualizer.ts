/**
 * Circular audio spectrum visualizer: two analysers (blue and red) drawn around a ring
 * on a canvas, fed by a Web Audio graph built on top of an <audio> element.
 */

const FREQUENCY_BINS = 1024; // AnalyserNode.fftSize (2048) / 2
const POINTS_PER_SIDE = 120;
const ELLIPSE_RATIO = 0.95;
const STROKE_PADDING = 3;

// Safari < 14.1 only ships the prefixed constructor.
interface LegacyAudioWindow {
	AudioContext?: typeof AudioContext;
	webkitAudioContext?: typeof AudioContext;
}

// Context state changes can race with teardown; failures here are harmless.
function ignoreError() {
	/* noop */
}

interface VisualState {
	canvasContext: CanvasRenderingContext2D;
	tick: number;
}

/** What an Analyser needs from the sound graph and the canvas owner. */
interface AnalyserHost {
	audioContext: AudioContext;
	isReady: boolean;
	visual: VisualState;
}

interface SoundVisual extends VisualState {
	draw: () => void;
}

interface AnalyserOptions {
	audio: AnalyserHost;
	color: string;
	/** `AnalyserNode.smoothingTimeConstant`. */
	smoothTime: number;
	/** Amplitude multiplier. */
	scale: number;
	/** Frequency range (Hz) the ring reacts to. */
	min: number;
	max: number;
	/**
	 * Angular shift of the ring and, when positive, the number of frames the spectrum is
	 * delayed by. Its sign also sets the direction of the small positional offset.
	 */
	offset: number;
	radius: number;
}

class Analyser {
	readonly analyser: AnalyserNode;

	private readonly audio: AnalyserHost;
	private readonly color: string;
	private readonly scale: number;
	private readonly radius: number;
	private readonly offset: number;
	private readonly radiusOffset: number;
	private readonly delay: number;
	private readonly sourceStart: number;
	private readonly sourceEnd: number;
	private readonly sourceLength: number;
	private readonly adjustOffset: number;
	private readonly interval: number;
	private readonly totalLength: number;

	// Pre-allocated buffers: a ring of the last (delay + 1) analyser frames, a shared "silence"
	// frame and the per-point amplitudes, so update() makes no per-frame allocations.
	private readonly spectrumRing: Float32Array<ArrayBuffer>[];
	private readonly silence = new Float32Array(FREQUENCY_BINS);
	private readonly frequencies = new Float64Array(POINTS_PER_SIDE);
	private ringHead = 0;
	private count = 0;
	private spectrums: Float32Array = this.silence;

	constructor(options: AnalyserOptions) {
		this.audio = options.audio;
		this.color = options.color;
		this.scale = options.scale;
		this.radius = options.radius;
		this.offset = options.offset;
		this.radiusOffset = 16 * this.offset;

		const { audioContext } = this.audio;
		this.analyser = audioContext.createAnalyser();
		this.analyser.fftSize = FREQUENCY_BINS * 2;
		this.analyser.smoothingTimeConstant = options.smoothTime;

		// Nyquist frequency: half of the real sample rate (44.1 kHz or 48 kHz depending on device).
		const nyquist = audioContext.sampleRate / 2;
		this.sourceStart = Math.ceil((FREQUENCY_BINS * options.min) / nyquist);
		this.sourceEnd = Math.round((FREQUENCY_BINS * options.max) / nyquist);
		this.sourceLength = this.sourceEnd - this.sourceStart + 1;
		this.adjustOffset = Math.round(this.sourceLength * 0.12);
		this.interval = (this.sourceLength - 1) / (POINTS_PER_SIDE - 1);
		this.totalLength = Math.round((POINTS_PER_SIDE * 3) / 2);

		this.delay = Math.max(0, this.offset);
		this.spectrumRing = Array.from(
			{ length: this.delay + 1 },
			() => new Float32Array(FREQUENCY_BINS),
		);
	}

	update() {
		this.readSpectrum();

		const { audio, color, frequencies, offset, radius, sourceEnd, sourceLength, sourceStart } =
			this;
		const { spectrums, totalLength } = this;
		const { canvasContext, tick } = audio.visual;
		canvasContext.strokeStyle = color;
		canvasContext.fillStyle = color;

		let average = 0;
		for (let i = sourceStart; i <= sourceEnd; i++) {
			average += spectrums[i];
		}
		average /= sourceLength;
		average = !audio.isReady || average === 0 ? average : Math.min(-40, Math.max(average, -60));

		canvasContext.beginPath();

		for (let i = 0; i < POINTS_PER_SIDE; i++) {
			frequencies[i] = this.interpolate(i, average);
			this.lineTo(
				canvasContext,
				(i + tick + offset) / (totalLength - 1),
				radius + frequencies[i] + STROKE_PADDING,
			);
		}

		for (let i = 1; i <= POINTS_PER_SIDE; i++) {
			this.lineTo(
				canvasContext,
				(i / 2 + POINTS_PER_SIDE - 1 + tick + offset) / (totalLength - 1),
				radius + frequencies[POINTS_PER_SIDE - i] + STROKE_PADDING,
			);
		}

		for (let i = POINTS_PER_SIDE; i > 0; i--) {
			this.lineTo(
				canvasContext,
				(i / 2 + POINTS_PER_SIDE - 1 + tick + offset) / (totalLength - 1),
				radius - frequencies[POINTS_PER_SIDE - i] - STROKE_PADDING,
			);
		}

		for (let i = POINTS_PER_SIDE - 1; i >= 0; i--) {
			this.lineTo(
				canvasContext,
				(i + tick + offset) / (totalLength - 1),
				radius - frequencies[i] - STROKE_PADDING,
			);
		}

		canvasContext.fill();
	}

	/** Picks the spectrum frame to draw: the one captured `delay` updates ago. */
	private readSpectrum() {
		if (!this.audio.isReady) {
			this.spectrums = this.silence;
			return;
		}

		const ringLength = this.spectrumRing.length;
		this.analyser.getFloatFrequencyData(this.spectrumRing[this.ringHead]);

		const delayed = this.spectrumRing[(this.ringHead - this.delay + ringLength) % ringLength];
		// The analyser reports -Infinity while there is no signal.
		this.spectrums =
			this.count < this.offset || !Number.isFinite(delayed[0]) ? this.silence : delayed;

		this.ringHead = (this.ringHead + 1) % ringLength;
		this.count++;
	}

	private adjustFrequency(i: number, average: number) {
		const amplitude = Math.max(0, this.spectrums[this.sourceStart + i] - average) * this.scale;
		const ratio = (i - this.sourceStart) / this.adjustOffset;
		return (
			amplitude * Math.max(0, Math.min(1, (5 / 6) * (ratio - 1) * (ratio - 1) * (ratio - 1) + 1))
		);
	}

	/** Catmull-Rom interpolation between the four nearest spectrum samples. */
	private interpolate(i: number, average: number) {
		const last = this.sourceLength - 1;
		const n1 = Math.floor(i * this.interval);
		let n2 = n1 + 1;
		const n0 = Math.abs(n1 - 1);
		let n3 = n1 + 2;

		n2 = n2 > last ? last * 2 - n2 : n2;
		n3 = n3 > last ? last * 2 - n3 : n3;

		const p0 = this.adjustFrequency(n0, average);
		const p1 = this.adjustFrequency(n1, average);
		const p2 = this.adjustFrequency(n2, average);
		const p3 = this.adjustFrequency(n3, average);

		const mu = i * this.interval - n1;
		const mu2 = mu * mu;

		const a0 = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
		const a1 = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
		const a2 = -0.5 * p0 + 0.5 * p2;

		return Math.max(0, a0 * mu * mu2 + a1 * mu2 + a2 * mu + p1);
	}

	/** Adds a point given in polar coordinates (`angle` in turns) to the current path. */
	private lineTo(context: CanvasRenderingContext2D, angle: number, radius: number) {
		const x = Math.cos(angle * 2 * Math.PI) * radius;
		const y = Math.sin(angle * 2 * Math.PI) * radius * ELLIPSE_RATIO;
		context.lineTo(x + this.radiusOffset, y + this.radiusOffset);
	}
}

class Sound implements AnalyserHost {
	isReady = false;
	readonly audioContext: AudioContext;

	private readonly analysers: Analyser[] = [];
	private source?: MediaElementAudioSourceNode;
	private frameId = 0;
	private isDestroyed = false;

	constructor(
		readonly visual: SoundVisual,
		private readonly audio: HTMLAudioElement,
	) {
		const legacyWindow = window as unknown as LegacyAudioWindow;
		const AudioContextClass = legacyWindow.AudioContext ?? legacyWindow.webkitAudioContext;
		if (!AudioContextClass) throw new Error('Web Audio API is not supported');
		this.audioContext = new AudioContextClass();
	}

	init() {
		this.analysers.push(
			new Analyser({
				audio: this,
				smoothTime: 0.7,
				color: '#b0c2e6',
				scale: 2,
				min: 1,
				max: 600,
				offset: 1,
				radius: 350,
			}),
			new Analyser({
				audio: this,
				smoothTime: 0.82,
				color: '#ec8585',
				scale: 1.8,
				min: 1,
				max: 600,
				offset: -1,
				radius: 350,
			}),
		);

		this.source = this.audioContext.createMediaElementSource(this.audio);
		for (const { analyser } of this.analysers) this.source.connect(analyser);
		this.source.connect(this.audioContext.destination);

		this.resume();
		this.isReady = true;
		this.render();
	}

	update() {
		for (const analyser of this.analysers) analyser.update();
	}

	// A context created outside a user gesture starts "suspended" and plays silence
	// once the <audio> element is routed through it, so it must be resumed explicitly.
	resume() {
		if (this.audioContext.state === 'suspended') {
			this.audioContext.resume().catch(ignoreError);
		}
	}

	destroy() {
		this.isDestroyed = true;
		cancelAnimationFrame(this.frameId);
		this.source?.disconnect();
		for (const { analyser } of this.analysers) analyser.disconnect();
		if (this.audioContext.state !== 'closed') this.audioContext.close().catch(ignoreError);
	}

	private render() {
		if (this.isDestroyed) return;
		this.visual.draw();
		this.frameId = requestAnimationFrame(() => {
			this.render();
		});
	}
}

class Visualizer {
	canvasContext: CanvasRenderingContext2D;
	tick = 0;

	private readonly sound: Sound;
	// The picture is drawn in a fixed logical space (radius 350 etc.) and scaled to the bitmap,
	// so the bitmap can match the real on-screen pixels instead of always being 1500x1500.
	private logicalSize = 0;
	private bitmapSize = 0;

	constructor(
		audio: HTMLAudioElement,
		private readonly canvas: HTMLCanvasElement,
	) {
		const context = canvas.getContext('2d');
		if (!context) throw new Error('2D canvas context is not available');
		this.canvasContext = context;

		this.sound = new Sound(this, audio);
		this.sound.init();
	}

	/** `logicalSize`: drawing space; `bitmapSize`: canvas resolution in device pixels. */
	setSize(logicalSize: number, bitmapSize = logicalSize) {
		this.logicalSize = logicalSize;
		this.bitmapSize = bitmapSize;
		this.canvas.width = bitmapSize;
		this.canvas.height = bitmapSize;
	}

	resume() {
		this.sound.resume();
	}

	destroy() {
		this.sound.destroy();
	}

	draw() {
		this.tick += 0.07;
		const context = this.canvasContext;

		context.save();
		context.clearRect(0, 0, this.bitmapSize, this.bitmapSize);
		context.scale(this.bitmapSize / this.logicalSize, this.bitmapSize / this.logicalSize);
		context.translate(this.logicalSize / 2, this.logicalSize / 2);
		context.lineWidth = 3;

		this.sound.update();

		context.restore();
	}
}

export { Analyser, Visualizer };
export type { AnalyserHost };
