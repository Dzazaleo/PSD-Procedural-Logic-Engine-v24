import React, { memo, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Handle, Position, NodeProps, useReactFlow, useUpdateNodeInternals, useEdges, useNodes } from 'reactflow';
import { PSDNodeData, TransformedPayload, LayerOverride, ChatMessage, ReviewerStrategy, ReviewerInstanceState, TransformedLayer, FeedbackStrategy } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { GoogleGenAI, Type } from "@google/genai";
import { Check, MessageSquare, AlertCircle, ShieldCheck, Search, Activity, Brain, Ban, Link as LinkIcon, Layers, Lock, Move, Anchor, Zap } from 'lucide-react';

const DEFAULT_INSTANCE_STATE: ReviewerInstanceState = {
    chatHistory: [],
    reviewerStrategy: null
};

interface SemanticBadgeProps {
    role?: 'flow' | 'static' | 'overlay' | 'background';
    anchorId?: string;
    citedRule?: string;
}

const SemanticBadge = ({ role, anchorId, citedRule }: SemanticBadgeProps) => {
    if (!role) return null;

    let colorClass = 'bg-slate-700 text-slate-400 border-slate-600';
    let icon = <Layers className="w-2.5 h-2.5" />;
    
    if (role === 'flow') { colorClass = 'bg-blue-900/30 text-blue-300 border-blue-500/30'; icon = <Move className="w-2.5 h-2.5" />; }
    else if (role === 'static') { colorClass = 'bg-purple-900/30 text-purple-300 border-purple-500/30'; icon = <Lock className="w-2.5 h-2.5" />; }
    else if (role === 'overlay') { colorClass = 'bg-pink-900/30 text-pink-300 border-pink-500/30'; icon = <Anchor className="w-2.5 h-2.5" />; }
    else if (role === 'background') { colorClass = 'bg-slate-800 text-slate-500 border-slate-700'; }

    return (
        <div className="flex flex-col items-start gap-1">
            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[8px] font-bold uppercase tracking-wider ${colorClass}`}>
                {icon}
                <span>{role}</span>
            </div>
            {anchorId && (
                <div className="flex items-center gap-1 text-[8px] text-pink-400/80 font-mono pl-1">
                    <LinkIcon className="w-2 h-2" />
                    <span className="truncate max-w-[80px]">Link: {anchorId}</span>
                </div>
            )}
        </div>
    );
};

const ReviewerInstanceRow = memo(({ 
    index, instanceState, payload, onChat, onVerify, onCommit, isPolished, isAnalyzing, isSyncing, activeKnowledge 
}: { 
    index: number, instanceState: ReviewerInstanceState, payload: TransformedPayload | null, onChat: (idx: number, msg: string) => void, onVerify: (idx: number) => void, onCommit: (idx: number) => void, isPolished: boolean, isAnalyzing: boolean, isSyncing: boolean, activeKnowledge: any 
}) => {
    const [inputValue, setInputValue] = useState("");
    const [isInspectorOpen, setInspectorOpen] = useState(false);
    const chatEndRef = useRef<HTMLDivElement>(null);
    
    // Phase 3b: Confidence Visualization
    const triangulation = payload?.triangulation;
    let confidenceColor = 'text-slate-500 bg-slate-800/50 border-slate-700';
    if (triangulation?.confidence_verdict === 'HIGH') confidenceColor = 'text-emerald-300 bg-emerald-900/30 border-emerald-500/50';
    else if (triangulation?.confidence_verdict === 'MEDIUM') confidenceColor = 'text-yellow-300 bg-yellow-900/30 border-yellow-500/50';
    else if (triangulation?.confidence_verdict === 'LOW') confidenceColor = 'text-red-300 bg-red-900/30 border-red-500/50';
    
    const hasStrategy = !!instanceState.reviewerStrategy?.overrides?.length;

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [instanceState.chatHistory]);

    const handleSend = () => {
        if (!inputValue.trim()) return;
        onChat(index, inputValue);
        setInputValue("");
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (!payload) return (
        <div className="p-4 text-center text-slate-500 italic text-xs border-b border-slate-700/50">
            Waiting for upstream payload...
        </div>
    );

    // Flatten layers for the inspector
    const flatLayers: TransformedLayer[] = [];
    const traverse = (layers: TransformedLayer[]) => {
        layers.forEach(l => {
            flatLayers.push(l);
            if (l.children) traverse(l.children);
        });
    };
    if (payload.layers) traverse(payload.layers);

    return (
        <div className="border-b border-slate-700/50 bg-slate-800/30 hover:bg-slate-800/50 transition-colors">
            {/* Header / Status Bar */}
            <div className="p-2 flex items-center justify-between">
                 <div className="flex items-center space-x-2">
                     <div className={`w-2 h-2 rounded-full ${isPolished ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-slate-600'}`}></div>
                     <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wide">
                         {payload.targetContainer || `Instance ${index}`}
                     </span>
                     
                     {/* Confidence Badge */}
                     {triangulation && (
                         <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded border ${confidenceColor} ml-2`}>
                             <Activity className="w-3 h-3" />
                             <span className="text-[9px] font-bold tracking-wider">{triangulation.confidence_verdict} CONFIDENCE</span>
                         </div>
                     )}
                 </div>

                 <div className="flex items-center space-x-2">
                     {/* Semantic Inspector Toggle */}
                     <button 
                        onClick={() => setInspectorOpen(!isInspectorOpen)}
                        className={`p-1.5 rounded transition-colors ${isInspectorOpen ? 'bg-indigo-500/20 text-indigo-300' : 'text-slate-500 hover:text-slate-300'}`}
                        title="Toggle Semantic Inspector"
                     >
                         <Search className="w-3.5 h-3.5" />
                     </button>
                     
                     {/* Push to Physics Button (Feedback Loop) */}
                     <button
                        onClick={() => onCommit(index)}
                        disabled={!hasStrategy || isSyncing}
                        className={`flex items-center space-x-1 px-2 py-1 rounded transition-all shadow-sm border text-[9px] font-bold uppercase tracking-wide
                            ${hasStrategy 
                                ? 'bg-indigo-600 hover:bg-indigo-500 text-white border-indigo-500' 
                                : 'bg-slate-700 text-slate-500 border-slate-600 cursor-not-allowed opacity-50'}
                        `}
                        title={hasStrategy ? "Commit constraints to Remapper logic" : "No overrides to commit"}
                     >
                         <Zap className={`w-3 h-3 ${isSyncing ? 'animate-pulse' : ''}`} />
                         <span>{isSyncing ? 'Syncing...' : 'Push Fixes'}</span>
                     </button>

                     {/* Verify Button */}
                     {isPolished ? (
                         <div className="flex items-center space-x-1 px-2 py-1 bg-emerald-900/20 border border-emerald-500/30 rounded text-emerald-400">
                             <ShieldCheck className="w-3 h-3" />
                             <span className="text-[9px] font-bold">VERIFIED</span>
                         </div>
                     ) : (
                         <button 
                            onClick={() => onVerify(index)}
                            className="flex items-center space-x-1 px-2 py-1 bg-slate-700 hover:bg-emerald-600 text-slate-300 hover:text-white rounded transition-all shadow-sm hover:shadow-md border border-slate-600 hover:border-emerald-500 text-[9px] font-bold uppercase tracking-wide"
                         >
                            <Check className="w-3 h-3" />
                            <span>Verify</span>
                         </button>
                     )}
                 </div>
            </div>

            {/* Semantic Inspector Panel */}
            {isInspectorOpen && (
                <div className="px-3 pb-3">
                    <div className="bg-slate-900/50 border border-slate-700 rounded h-48 overflow-hidden flex flex-col">
                        <div className="px-2 py-1.5 bg-slate-900 border-b border-slate-700 flex justify-between items-center">
                            <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                <Brain className="w-3 h-3 text-indigo-400" />
                                Semantic Audit
                            </span>
                            <span className="text-[9px] text-slate-600 font-mono">{flatLayers.length} Layers Analyzed</span>
                        </div>
                        <div className="overflow-y-auto custom-scrollbar p-1 space-y-0.5">
                            {flatLayers.map((layer) => (
                                <div key={layer.id} className="flex items-start justify-between p-1.5 hover:bg-slate-800/50 rounded group">
                                    <div className="flex flex-col max-w-[60%]">
                                        <span className="text-[10px] text-slate-300 font-medium truncate" title={layer.name}>
                                            {layer.name}
                                        </span>
                                        <span className="text-[8px] text-slate-600 font-mono truncate">{layer.id}</span>
                                    </div>
                                    <SemanticBadge 
                                        role={layer.layoutRole} 
                                        anchorId={layer.linkedAnchorId} 
                                        citedRule={layer.citedRule} 
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Manual Control / Chat Interface */}
            <div className="px-3 pb-3">
                {instanceState.chatHistory.length > 0 && (
                    <div className="mb-2 space-y-2 max-h-32 overflow-y-auto custom-scrollbar p-2 bg-slate-900/30 rounded border border-slate-700/50">
                        {instanceState.chatHistory.map((msg, idx) => (
                            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-[85%] px-2 py-1.5 rounded text-[10px] ${msg.role === 'user' ? 'bg-indigo-600 text-white' : 'bg-slate-700 text-slate-300'}`}>
                                    {msg.parts[0].text}
                                </div>
                            </div>
                        ))}
                        <div ref={chatEndRef} />
                    </div>
                )}
                
                <div className="relative flex items-center">
                    <div className="absolute left-2 text-slate-500">
                        {isAnalyzing ? <Activity className="w-3.5 h-3.5 animate-spin" /> : <MessageSquare className="w-3.5 h-3.5" />}
                    </div>
                    <input 
                        type="text" 
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={activeKnowledge ? "Direct CARO (e.g. 'Nudge title up 10px')..." : "Manual adjustments (No Knowledge Linked)..."}
                        disabled={isAnalyzing}
                        className="w-full bg-slate-900 border border-slate-700 rounded pl-8 pr-8 py-1.5 text-[10px] text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                    <button 
                        onClick={handleSend}
                        disabled={!inputValue.trim() || isAnalyzing}
                        className="absolute right-1.5 text-indigo-400 hover:text-indigo-300 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                         <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                    </button>
                </div>
            </div>
        </div>
    );
});

export const DesignReviewerNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
    const instanceCount = data.instanceCount || 1;
    const reviewerInstances = data.reviewerInstances || {};
    const edges = useEdges();
    const { setNodes } = useReactFlow();
    const updateNodeInternals = useUpdateNodeInternals();
    const { payloadRegistry, updatePayload, unregisterNode, knowledgeRegistry, registerFeedback } = useProceduralStore();
    const [analyzingInstances, setAnalyzingInstances] = useState<Record<number, boolean>>({});
    const [syncingInstances, setSyncingInstances] = useState<Record<number, boolean>>({});

    useEffect(() => { return () => unregisterNode(id); }, [id, unregisterNode]);
    useEffect(() => { updateNodeInternals(id); }, [id, instanceCount, updateNodeInternals]);

    const activeKnowledge = useMemo(() => {
        const edge = edges.find(e => e.target === id && e.targetHandle === 'knowledge-in');
        if (!edge) return null;
        return knowledgeRegistry[edge.source];
    }, [edges, id, knowledgeRegistry]);

    // Upstream Lookup: Identify which Remapper corresponds to this instance index
    const findUpstreamRemapper = useCallback((index: number) => {
        // The Reviewer input 'source-in-X' is connected to the Remapper output 'result-out-X'
        const edge = edges.find(e => e.target === id && e.targetHandle === `source-in-${index}`);
        if (!edge) return null;
        return { nodeId: edge.source, handleId: edge.sourceHandle || '' };
    }, [edges, id]);

    const updateInstanceState = useCallback((index: number, updates: Partial<ReviewerInstanceState>) => {
        setNodes((nds) => nds.map((n) => {
            if (n.id === id) {
                const currentInstances = n.data.reviewerInstances || {};
                const oldState = currentInstances[index] || DEFAULT_INSTANCE_STATE;
                return {
                    ...n,
                    data: {
                        ...n.data,
                        reviewerInstances: {
                            ...currentInstances,
                            [index]: { ...oldState, ...updates }
                        }
                    }
                };
            }
            return n;
        }));
    }, [id, setNodes]);

    const performManualAudit = async (index: number, userMessage: string, currentHistory: ChatMessage[], payload: TransformedPayload) => {
        setAnalyzingInstances(prev => ({ ...prev, [index]: true }));
        
        try {
            const apiKey = process.env.API_KEY;
            if (!apiKey) throw new Error("API_KEY missing");
            const ai = new GoogleGenAI({ apiKey });

            const systemInstruction = `
                ROLE: Design Reviewer (Manual Override Mode).
                TASK: Interpret the user's natural language request to adjust the layout.
                CONTEXT: You are modifying a previously generated layout.
                
                CURRENT LAYERS (Simplified):
                ${JSON.stringify(payload.layers.map(l => ({ id: l.id, name: l.name, x: l.coords.x, y: l.coords.y })), null, 2)}

                KNOWLEDGE CONTEXT:
                ${activeKnowledge ? activeKnowledge.rules : "No active rules."}

                USER REQUEST: "${userMessage}"

                OUTPUT:
                Return a JSON object with an 'overrides' array.
                Each override must have:
                - layerId: The exact ID of the layer to move.
                - xOffset: The NEW relative offset (or delta).
                - yOffset: The NEW relative offset (or delta).
                - individualScale: The scale factor (default 1.0).
                
                NOTE: You are effectively applying a 'delta' to the current position. 
                If the user says "Move title down 10px", find the title layer and add 10 to its yOffset.
            `;

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: userMessage }] }],
                config: {
                    systemInstruction,
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            reasoning: { type: Type.STRING },
                            overrides: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        layerId: { type: Type.STRING },
                                        xOffset: { type: Type.NUMBER },
                                        yOffset: { type: Type.NUMBER },
                                        individualScale: { type: Type.NUMBER }
                                    },
                                    required: ['layerId', 'xOffset', 'yOffset', 'individualScale']
                                }
                            }
                        }
                    }
                }
            });

            const json = JSON.parse(response.text || '{}');
            
            // Construct the AI response message
            const aiMessage: ChatMessage = {
                id: Date.now().toString(),
                role: 'model',
                parts: [{ text: json.reasoning || "Adjustments applied." }],
                timestamp: Date.now()
            };

            // Update Chat History and Reviewer Strategy
            const newHistory = [...currentHistory, aiMessage];
            updateInstanceState(index, { 
                chatHistory: newHistory, 
                reviewerStrategy: { CARO_Audit: "Manual Adjustment", overrides: json.overrides } 
            });

        } catch (e) {
            console.error("Manual Audit Failed", e);
            const errorMsg: ChatMessage = { id: Date.now().toString(), role: 'model', parts: [{ text: "Failed to process adjustment." }], timestamp: Date.now() };
            updateInstanceState(index, { chatHistory: [...currentHistory, errorMsg] });
        } finally {
            setAnalyzingInstances(prev => ({ ...prev, [index]: false }));
        }
    };

    const handleChat = (index: number, message: string) => {
        const instanceState = reviewerInstances[index] || DEFAULT_INSTANCE_STATE;
        
        // Find input payload
        const edge = edges.find(e => e.target === id && e.targetHandle === `source-in-${index}`);
        const sourcePayload = edge ? payloadRegistry[edge.source]?.[edge.sourceHandle || ''] : null;

        if (!sourcePayload) return;

        const userMsg: ChatMessage = {
            id: Date.now().toString(),
            role: 'user',
            parts: [{ text: message }],
            timestamp: Date.now()
        };

        const newHistory = [...instanceState.chatHistory, userMsg];
        updateInstanceState(index, { chatHistory: newHistory });

        performManualAudit(index, message, newHistory, sourcePayload);
    };

    const handleCommit = useCallback((index: number) => {
        const instanceState = (data.reviewerInstances || {})[index];
        if (!instanceState?.reviewerStrategy) return;
    
        const upstream = findUpstreamRemapper(index);
        if (!upstream) {
            console.warn("No upstream Remapper found for commit");
            return;
        }
    
        const feedback: FeedbackStrategy = {
            overrides: instanceState.reviewerStrategy.overrides,
            isCommitted: true
        };
    
        // UI Feedback state
        setSyncingInstances(prev => ({ ...prev, [index]: true }));
        
        // Dispatch to Global Store
        registerFeedback(upstream.nodeId, upstream.handleId, feedback);
    
        // Simulate network/processing delay for UX
        setTimeout(() => {
            setSyncingInstances(prev => ({ ...prev, [index]: false }));
        }, 600);
    }, [data.reviewerInstances, findUpstreamRemapper, registerFeedback]);

    const handleVerify = (index: number) => {
        // "Verify" passes the payload through as 'polished' without changing geometry.
        const edge = edges.find(e => e.target === id && e.targetHandle === `source-in-${index}`);
        const sourcePayload = edge ? payloadRegistry[edge.source]?.[edge.sourceHandle || ''] : null;

        if (sourcePayload) {
            updatePayload(id, `result-out-${index}`, {
                ...sourcePayload,
                isPolished: true,
                status: 'success'
            });
        }
    };
    
    // Auto-Pass-Through for initial display
    useEffect(() => {
        for (let i = 0; i < instanceCount; i++) {
            const edge = edges.find(e => e.target === id && e.targetHandle === `source-in-${i}`);
            const sourcePayload = edge ? payloadRegistry[edge.source]?.[edge.sourceHandle || ''] : null;
            
            const myOutput = payloadRegistry[id]?.[`result-out-${i}`];
            if (sourcePayload && !myOutput) {
                updatePayload(id, `result-out-${i}`, { ...sourcePayload, isPolished: false });
            }
        }
    }, [edges, id, instanceCount, payloadRegistry, updatePayload]);

    const addInstance = () => {
        setNodes((nds) => nds.map((n) => {
            if (n.id === id) {
                return { ...n, data: { ...n.data, instanceCount: (n.data.instanceCount || 0) + 1 } };
            }
            return n;
        }));
    };

    return (
        <div className="w-[450px] bg-slate-800 rounded-lg shadow-2xl border border-slate-600 font-sans flex flex-col transition-colors duration-300">
            <Handle type="target" position={Position.Top} id="knowledge-in" className={`!w-4 !h-4 !-top-2 !bg-emerald-500 !border-2 !border-slate-900 z-50 transition-all duration-300 ${activeKnowledge ? 'shadow-[0_0_10px_#10b981]' : ''}`} style={{ left: '50%', transform: 'translateX(-50%)' }} title="Input: Global Knowledge (Context Only)" />

            <div className="bg-emerald-900/80 p-2 border-b border-emerald-800 flex items-center justify-between shrink-0 rounded-t-lg">
                <div className="flex items-center space-x-2">
                    <ShieldCheck className="w-4 h-4 text-emerald-300" />
                    <span className="text-sm font-semibold text-emerald-100">Design Reviewer</span>
                </div>
                <div className="flex items-center space-x-2">
                     {activeKnowledge && <span className="text-[9px] bg-emerald-900 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/30 uppercase tracking-wider font-bold">Knowledge Active</span>}
                    <span className="text-[10px] text-emerald-400/70 font-mono">AUDIT GATE</span>
                </div>
            </div>

            <div className="flex flex-col">
                {Array.from({ length: instanceCount }).map((_, i) => {
                    const edge = edges.find(e => e.target === id && e.targetHandle === `source-in-${i}`);
                    const sourcePayload = edge ? payloadRegistry[edge.source]?.[edge.sourceHandle || ''] : null;
                    const myOutput = payloadRegistry[id]?.[`result-out-${i}`];
                    const isPolished = myOutput?.isPolished || false;
                    const instanceState = reviewerInstances[i] || DEFAULT_INSTANCE_STATE;

                    return (
                        <div key={i} className="relative">
                            <Handle type="target" position={Position.Left} id={`source-in-${i}`} className="!absolute !-left-2 !top-8 !w-3 !h-3 !rounded-full !bg-purple-500 !border-2 !border-slate-800 z-50" />
                            <ReviewerInstanceRow 
                                index={i}
                                instanceState={instanceState}
                                payload={sourcePayload}
                                onChat={handleChat}
                                onVerify={handleVerify}
                                onCommit={handleCommit}
                                isPolished={isPolished}
                                isAnalyzing={!!analyzingInstances[i]}
                                isSyncing={!!syncingInstances[i]}
                                activeKnowledge={activeKnowledge}
                            />
                            <Handle type="source" position={Position.Right} id={`result-out-${i}`} className="!absolute !-right-2 !top-8 !w-3 !h-3 !rounded-full !bg-emerald-500 !border-2 !border-slate-800 z-50" />
                        </div>
                    );
                })}
            </div>
            
            <button onClick={addInstance} className="w-full py-2 bg-slate-900 hover:bg-slate-700 border-t border-slate-700 text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center space-x-1 rounded-b-lg">
                <span className="text-[10px] font-medium uppercase tracking-wider">+ Add Audit Instance</span>
            </button>
        </div>
    );
});