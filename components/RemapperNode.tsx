import React, { memo, useEffect, useState, useMemo, useCallback } from 'react';
import { Handle, Position, NodeProps, useEdges, useNodes, NodeResizer, useUpdateNodeInternals, useReactFlow } from 'reactflow';
import { PSDNodeData, TransformedPayload, TransformedLayer, LayoutStrategy, LayerOverride, FeedbackStrategy, MappingContext, ContainerDefinition, SerializableLayer } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { Cpu, ArrowRight, RefreshCw, Zap, Lock, Move, Anchor, Layers, Settings2 } from 'lucide-react';

interface InstanceState {
    lastProcessed: number;
    isProcessing: boolean;
}

const RemapperInstance = memo(({ 
    index, 
    nodeId, 
    edges, 
    nodes, 
    resolvedRegistry, 
    templateRegistry, 
    feedbackRegistry,
    registerPayload 
}: {
    index: number;
    nodeId: string;
    edges: any[];
    nodes: any[];
    resolvedRegistry: any;
    templateRegistry: any;
    feedbackRegistry: any;
    registerPayload: any;
}) => {
    // 1. Resolve Inputs
    const sourceEdge = edges.find(e => e.target === nodeId && e.targetHandle === `source-in-${index}`);
    const targetEdge = edges.find(e => e.target === nodeId && e.targetHandle === `target-in-${index}`);
    
    // Source Data (Container Context + Layers + AI Strategy)
    const sourceContext: MappingContext | null = sourceEdge 
        ? resolvedRegistry[sourceEdge.source]?.[sourceEdge.sourceHandle || ''] 
        : null;
        
    // Target Data (Bounds)
    const targetBounds = useMemo(() => {
        if (!targetEdge) return null;
        
        // Case A: From Target Splitter (Handle contains bounds info or container name)
        // The TargetSplitter output handle is usually the container name "slot-bounds-{name}"
        let containerName = targetEdge.sourceHandle || '';
        if (containerName.startsWith('slot-bounds-')) {
            containerName = containerName.replace('slot-bounds-', '');
        } else if (containerName.startsWith('target-out-')) {
            // Case B: From Design Analyst (Proxy)
            // We need to look up the proxy template in the source node
            // But usually Analyst outputs fully resolved context on source-out. 
            // If connected to target-in, it might be providing raw dimensions.
        }

        const template = templateRegistry[targetEdge.source];
        if (template && template.containers) {
            const container = template.containers.find((c: ContainerDefinition) => c.name === containerName);
            return container ? container.bounds : null;
        }
        return null;
    }, [targetEdge, templateRegistry]);

    // Feedback Loop (Manual Overrides from Reviewer)
    // Reviewer sends feedback to the node that feeds it. 
    // Reviewer input is 'source-in-{i}', connected to Remapper 'result-out-{i}'.
    // So Reviewer sends feedback to (nodeId, result-out-{i}).
    const feedback: FeedbackStrategy | null = feedbackRegistry[nodeId]?.[`result-out-${index}`] || null;

    // 2. Transformation Logic (Physics Engine)
    useEffect(() => {
        if (!sourceContext || !targetBounds) return;

        const { container: sourceContainer, layers: sourceLayers, aiStrategy } = sourceContext;
        const overrides = feedback?.overrides || aiStrategy?.overrides || [];
        
        // Helper: Get override for specific layer
        const getOverride = (layerId: string): LayerOverride | undefined => {
            return overrides.find(o => o.layerId === layerId);
        };

        // Recursive Transformation
        const transformLayers = (layers: SerializableLayer[], depth = 0): TransformedLayer[] => {
            const transformed: TransformedLayer[] = layers.map(layer => {
                // 1. Determine Scale Strategy
                // Default: Fit width to target width (Maintain Aspect Ratio)
                const scaleX_Global = targetBounds.w / sourceContainer.bounds.w;
                const scaleY_Global = targetBounds.h / sourceContainer.bounds.h;
                const uniformScale = Math.min(scaleX_Global, scaleY_Global);
                
                let finalScale = uniformScale;
                
                // AI/Manual Override
                const override = getOverride(layer.id);
                if (override && override.individualScale) {
                    finalScale = uniformScale * override.individualScale;
                } else if (aiStrategy?.suggestedScale) {
                    finalScale = uniformScale * aiStrategy.suggestedScale;
                }

                // 2. Determine Position
                // Default: Center in target
                const layerW = layer.coords.w * finalScale;
                const layerH = layer.coords.h * finalScale;
                
                // Center of Target
                const cx = targetBounds.x + (targetBounds.w / 2);
                const cy = targetBounds.y + (targetBounds.h / 2);
                
                let posX = cx - (layerW / 2);
                let posY = cy - (layerH / 2);

                // Apply Offsets
                if (override) {
                    posX = targetBounds.x + override.xOffset; // Absolute X relative to target Origin
                    posY = targetBounds.y + override.yOffset; // Absolute Y relative to target Origin
                }

                return {
                    ...layer,
                    transform: {
                        scaleX: finalScale,
                        scaleY: finalScale, // Uniform scaling for now
                        offsetX: 0, // Baked into coords for this pipeline
                        offsetY: 0,
                        rotation: override?.rotation || 0
                    },
                    coords: {
                        x: posX,
                        y: posY,
                        w: layerW,
                        h: layerH
                    },
                    // Pass specific AI metadata
                    layoutRole: override?.layoutRole,
                    linkedAnchorId: override?.linkedAnchorId,
                    citedRule: override?.citedRule,
                    generativePrompt: (aiStrategy?.method === 'GENERATIVE' || aiStrategy?.method === 'HYBRID') 
                        ? aiStrategy.generativePrompt 
                        : undefined,
                    type: (aiStrategy?.replaceLayerId === layer.id) ? 'generative' : layer.type,
                    children: layer.children ? transformLayers(layer.children, depth + 1) : undefined
                };
            });

            // STEP 3 & 4: Physics Engine (Only at Root Depth)
            if (depth === 0 && aiStrategy) {
                const strategy = aiStrategy;

                // A. GRID SOLVER (Semantic: Only 'flow' items)
                // Note: If no role is set, we default to 'flow' to maintain backward compatibility with non-semantic strategies
                const gridCandidates = transformed.filter(l => {
                    // FIX: Priority Override (Immutable Lock)
                    // If a layer has an explicit override (Manual User Adjustment or Strong AI Directive),
                    // we treat its position as intentional and exclude it from the automatic grid solver.
                    const override = getOverride(l.id);
                    if (override) return false;

                    const isFlow = !l.layoutRole || l.layoutRole === 'flow';
                    return isFlow;
                });

                if (gridCandidates.length > 0) {
                     if (strategy.layoutMode === 'DISTRIBUTE_HORIZONTAL' || strategy.layoutMode === 'GRID') {
                        // Simple 1-Row Distribution
                        const totalW = targetBounds.w;
                        const margin = totalW * 0.05;
                        const availableW = totalW - (margin * 2);
                        const step = availableW / gridCandidates.length;
                        
                        gridCandidates.forEach((l, idx) => {
                            // Center X of the slot
                            const slotCX = targetBounds.x + margin + (step * idx) + (step / 2);
                            l.coords.x = slotCX - (l.coords.w / 2);
                            // Keep Y centered (calculated above)
                        });
                     } else if (strategy.layoutMode === 'DISTRIBUTE_VERTICAL') {
                        // Simple 1-Column Distribution
                        const totalH = targetBounds.h;
                        const margin = totalH * 0.05;
                        const availableH = totalH - (margin * 2);
                        const step = availableH / gridCandidates.length;

                        gridCandidates.forEach((l, idx) => {
                             const slotCY = targetBounds.y + margin + (step * idx) + (step / 2);
                             l.coords.y = slotCY - (l.coords.h / 2);
                        });
                     }
                }
            }

            return transformed;
        };

        const resultLayers = transformLayers(sourceLayers);

        const payload: TransformedPayload = {
            status: 'success',
            sourceNodeId: nodeId, // Self as source of transform
            sourceContainer: sourceContainer.containerName,
            targetContainer: containerNameFromHandle(targetEdge?.sourceHandle) || 'Unknown',
            layers: resultLayers,
            scaleFactor: 1, // Normalized
            metrics: {
                source: { w: sourceContainer.bounds.w, h: sourceContainer.bounds.h },
                target: { w: targetBounds.w, h: targetBounds.h }
            },
            targetBounds: targetBounds,
            isConfirmed: feedback?.isCommitted || sourceContext.aiStrategy?.isExplicitIntent,
            // If AI says generate, we pass that flag
            requiresGeneration: (aiStrategy?.method === 'GENERATIVE' || aiStrategy?.method === 'HYBRID'),
            // Pass through previews if they exist (Drafts)
            previewUrl: sourceContext.previewUrl,
            sourceReference: sourceContext.aiStrategy?.sourceReference,
            generationId: Date.now(), // Timestamp versioning
            triangulation: aiStrategy?.triangulation
        };

        // REGISTER OUTPUT
        registerPayload(nodeId, `result-out-${index}`, payload);

    }, [sourceContext, targetBounds, feedback, nodeId, index, registerPayload]);

    return (
        <div className="relative flex items-center justify-between p-2 bg-slate-800/50 border-b border-slate-700/50 last:border-0 hover:bg-slate-700/30 transition-colors">
            {/* Input Handles */}
            <Handle type="target" position={Position.Left} id={`source-in-${index}`} className="!absolute !-left-2 !top-1/2 !-translate-y-3 !w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-800 z-50" title="Source Content" />
            <Handle type="target" position={Position.Left} id={`target-in-${index}`} className="!absolute !-left-2 !top-1/2 !translate-y-3 !w-3 !h-3 !bg-emerald-500 !border-2 !border-slate-800 z-50" title="Target Bounds" />
            
            <div className="flex items-center space-x-3 ml-3 overflow-hidden">
                <div className={`p-1.5 rounded bg-slate-900 border ${sourceContext ? 'border-indigo-500/50 text-indigo-400' : 'border-slate-700 text-slate-600'}`}>
                    <Layers className="w-3 h-3" />
                </div>
                
                <div className="flex flex-col">
                    <div className="flex items-center space-x-1">
                        <span className="text-[10px] font-bold text-slate-300">
                             {sourceContext?.container.containerName || `Instance ${index}`}
                        </span>
                        <ArrowRight className="w-3 h-3 text-slate-600" />
                        <span className="text-[10px] font-bold text-slate-300">
                             {containerNameFromHandle(targetEdge?.sourceHandle) || '?'}
                        </span>
                    </div>
                    <div className="flex items-center space-x-2 text-[9px] text-slate-500">
                        {sourceContext?.aiStrategy ? (
                            <span className="text-purple-400 flex items-center gap-0.5">
                                <Cpu className="w-2.5 h-2.5" /> AI
                                {sourceContext.aiStrategy.overrides?.length ? ` (${sourceContext.aiStrategy.overrides.length})` : ''}
                            </span>
                        ) : (
                            <span>Geometric</span>
                        )}
                        {feedback?.overrides?.length && (
                            <span className="text-orange-400 flex items-center gap-0.5 border-l border-slate-700 pl-2">
                                <Settings2 className="w-2.5 h-2.5" /> Manual
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* Output Handle */}
            <Handle type="source" position={Position.Right} id={`result-out-${index}`} className="!absolute !-right-2 !top-1/2 !-translate-y-1/2 !w-3 !h-3 !bg-blue-500 !border-2 !border-slate-800 z-50" title="Transformed Payload" />
        </div>
    );
});

// Helper
const containerNameFromHandle = (handle: string | null | undefined) => {
    if (!handle) return null;
    if (handle.startsWith('slot-bounds-')) return handle.replace('slot-bounds-', '');
    if (handle.startsWith('target-out-')) return 'Proxy Target'; // Analyst proxy
    return handle;
};

export const RemapperNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
  const instanceCount = data.instanceCount || 1;
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const edges = useEdges();
  const nodes = useNodes();
  const { unregisterNode, resolvedRegistry, templateRegistry, feedbackRegistry, registerPayload } = useProceduralStore();

  useEffect(() => { return () => unregisterNode(id); }, [id, unregisterNode]);
  useEffect(() => { updateNodeInternals(id); }, [id, instanceCount, updateNodeInternals]);

  const addInstance = useCallback(() => {
    setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, instanceCount: instanceCount + 1 } } : n));
  }, [id, instanceCount, setNodes]);

  return (
    <div className="w-[500px] bg-slate-800 rounded-lg shadow-2xl border border-slate-600 font-sans flex flex-col transition-colors duration-300 relative group">
       <NodeResizer minWidth={500} minHeight={200} isVisible={true} handleStyle={{ background: 'transparent', border: 'none' }} lineStyle={{ border: 'none' }} />
       
       {/* Header */}
       <div className="bg-slate-900 p-2 border-b border-slate-700 flex items-center justify-between shrink-0 rounded-t-lg">
           <div className="flex items-center space-x-2">
               <div className="p-1.5 bg-blue-500/10 rounded border border-blue-500/20">
                   <Cpu className="w-4 h-4 text-blue-400" />
               </div>
               <div className="flex flex-col leading-none">
                   <span className="text-sm font-bold text-slate-100">Layout Remapper</span>
                   <span className="text-[9px] text-blue-400/70 font-mono">PHYSICS ENGINE</span>
               </div>
           </div>
           <div className="px-2 py-0.5 bg-black/30 rounded border border-slate-700 text-[9px] text-slate-400 font-mono">
               {instanceCount} CHANNELS
           </div>
       </div>

       {/* Instance List */}
       <div className="flex flex-col bg-slate-900/20">
           {Array.from({ length: instanceCount }).map((_, i) => (
               <RemapperInstance 
                   key={i} 
                   index={i} 
                   nodeId={id} 
                   edges={edges}
                   nodes={nodes}
                   resolvedRegistry={resolvedRegistry}
                   templateRegistry={templateRegistry}
                   feedbackRegistry={feedbackRegistry}
                   registerPayload={registerPayload}
               />
           ))}
       </div>

       {/* Footer */}
       <button onClick={addInstance} className="w-full py-1.5 bg-slate-900 hover:bg-slate-800 border-t border-slate-700 text-slate-500 hover:text-slate-300 transition-colors flex items-center justify-center space-x-1 rounded-b-lg group/btn">
            <span className="text-[9px] font-bold uppercase tracking-wider group-hover/btn:tracking-widest transition-all">+ Add Physics Channel</span>
       </button>
    </div>
  );
});