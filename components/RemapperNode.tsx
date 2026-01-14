import React, { memo, useState, useEffect, useMemo, useCallback } from 'react';
import { Handle, Position, NodeProps, useEdges, useUpdateNodeInternals, NodeResizer } from 'reactflow';
import { PSDNodeData, TransformedPayload, TransformedLayer, LayoutStrategy, FeedbackStrategy, SerializableLayer, ContainerContext } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { ArrowRightLeft, Cpu, AlertTriangle, Zap, Sliders, Box, Layers, RefreshCw, Lock } from 'lucide-react';

interface RemapperInstanceProps {
    index: number;
    nodeId: string;
    onStatusChange?: (index: number, active: boolean) => void;
}

// Helper to resolve overrides from Feedback (High Priority) or Strategy (Low Priority)
const getOverride = (layerId: string, feedback?: FeedbackStrategy | null, strategy?: LayoutStrategy | null) => {
    // 1. Manual Feedback Overrides (Highest Priority)
    if (feedback?.overrides) {
        const manual = feedback.overrides.find(o => o.layerId === layerId);
        if (manual) return manual;
    }
    // 2. AI Strategy Overrides
    if (strategy?.overrides) {
        return strategy.overrides.find(o => o.layerId === layerId);
    }
    return undefined;
};

const RemapperInstanceRow = memo(({ index, nodeId }: RemapperInstanceProps) => {
    const edges = useEdges();
    const { 
        resolvedRegistry, 
        templateRegistry, 
        registerPayload, 
        analysisRegistry, 
        feedbackRegistry,
        payloadRegistry
    } = useProceduralStore();

    // 1. Resolve Source Data (Content)
    const sourceData = useMemo(() => {
        const edge = edges.find(e => e.target === nodeId && e.targetHandle === `source-in-${index}`);
        if (!edge) return null;
        return resolvedRegistry[edge.source]?.[edge.sourceHandle || ''] || null;
    }, [edges, nodeId, index, resolvedRegistry]);

    // 2. Resolve Target Data (Bounds)
    const targetData = useMemo(() => {
        const edge = edges.find(e => e.target === nodeId && e.targetHandle === `target-in-${index}`);
        if (!edge) return null;
        
        // Strategy 1: Connected to TargetSplitter (Slot-based)
        // Handle ID is usually the container name (e.g. "hero_image")
        const template = templateRegistry[edge.source];
        if (template) {
            let containerName = edge.sourceHandle;
            if (containerName?.startsWith('slot-bounds-')) {
                containerName = containerName.replace('slot-bounds-', '');
            }
            return template.containers.find(c => c.name === containerName) || null;
        }

        // Strategy 2: Connected to another Remapper/Resolver (Chained)
        // Fallback to resolvedRegistry? (Not common for target defs)
        return null;
    }, [edges, nodeId, index, templateRegistry]);

    // 3. Resolve Strategies
    // The Analyst Node injects strategy into the 'sourceData' context (MappingContext.aiStrategy).
    // We also check for explicit feedback stored in the registry.
    const strategy = sourceData?.aiStrategy || null;
    
    // Feedback is keyed by THIS node's output handle, because Reviewer sends feedback TO this node.
    const feedback = feedbackRegistry[nodeId]?.[`result-out-${index}`] || null;

    // 4. Transformation Logic
    useEffect(() => {
        if (!sourceData || !targetData) return;

        // A. Base Metrics
        const sourceContainer = sourceData.container;
        const srcW = sourceContainer.bounds.w;
        const srcH = sourceContainer.bounds.h;
        const tgtW = targetData.bounds.w;
        const tgtH = targetData.bounds.h;
        const tgtX = targetData.bounds.x;
        const tgtY = targetData.bounds.y;

        // Default Geometric Fit (Contain)
        const scaleX = tgtW / srcW;
        const scaleY = tgtH / srcH;
        // If strategy suggests a global scale, use it. Otherwise uniform fit.
        const baseScale = strategy?.suggestedScale 
            ? strategy.suggestedScale 
            : Math.max(scaleX, scaleY); // Default to Cover for better fill? Or Contain? Let's use max (Cover) for design.

        // B. Recursive Transformer
        const transformLayer = (layer: SerializableLayer): TransformedLayer => {
            const override = getOverride(layer.id, feedback, strategy);
            
            // 1. Calculate relative position in source container
            const relX = layer.coords.x - sourceContainer.bounds.x;
            const relY = layer.coords.y - sourceContainer.bounds.y;

            // 2. Apply Base Scale
            // Anchor Center by default? Or Top-Left?
            // Standard geometric remapping usually anchors Top-Left or Center.
            // Let's assume Top-Left relative + Offset centering.
            
            // Calculate Centering Offset
            const scaledW = srcW * baseScale;
            const scaledH = srcH * baseScale;
            const offsetX = (tgtW - scaledW) / 2;
            const offsetY = (tgtH - scaledH) / 2;

            let newX = (relX * baseScale) + offsetX + tgtX;
            let newY = (relY * baseScale) + offsetY + tgtY;
            let newW = layer.coords.w * baseScale;
            let newH = layer.coords.h * baseScale;
            let newScaleX = baseScale;
            let newScaleY = baseScale;
            let rotation = 0;

            // 3. Apply Overrides
            if (override) {
                newX += override.xOffset;
                newY += override.yOffset;
                
                const indScale = override.individualScale || 1.0;
                // Scale is usually applied from center of layer
                const cx = newX + newW / 2;
                const cy = newY + newH / 2;
                
                newW *= indScale;
                newH *= indScale;
                newX = cx - newW / 2;
                newY = cy - newH / 2;
                
                newScaleX *= indScale;
                newScaleY *= indScale;

                if (override.rotation) rotation = override.rotation;
            }

            // 4. Construct Result
            const transformed: TransformedLayer = {
                ...layer,
                coords: { x: newX, y: newY, w: newW, h: newH },
                transform: {
                    scaleX: newScaleX,
                    scaleY: newScaleY,
                    offsetX: newX, // Absolute global position
                    offsetY: newY,
                    rotation: rotation
                },
                // Propagate Generative Props if method suggests
                type: (strategy?.method === 'GENERATIVE' && strategy.replaceLayerId === layer.id) 
                      ? 'generative' 
                      : layer.type,
                generativePrompt: (strategy?.replaceLayerId === layer.id) ? strategy.generativePrompt : undefined
            };

            if (layer.children) {
                transformed.children = layer.children.map(transformLayer);
            }

            return transformed;
        };

        let transformedLayers = (sourceData.layers as SerializableLayer[]).map(transformLayer);

        // C. COLLISION SOLVER (Semantic: Only 'flow' items)
        // We only run this on the top-level list or explicitly marked items in a flat pass if needed.
        // For now, we apply it to the root list.
        if (strategy?.physicsRules?.preventOverlap) {
            // Filter candidates
            const flowItems = transformedLayers.filter(l => {
                const override = getOverride(l.id, feedback, strategy);
                const role = override?.layoutRole;
                // Items without a specific role are treated as 'flow' if physics is on, 
                // UNLESS they are background/overlay.
                return role === 'flow' || (!role && l.type !== 'group'); 
            });
            
            // Sort by X position
            flowItems.sort((a, b) => a.coords.x - b.coords.x);
            
            const padding = 10; 

            for (let i = 1; i < flowItems.length; i++) {
                const prev = flowItems[i-1];
                const curr = flowItems[i];

                // FIX: Priority Override (Immutable Lock)
                // If the layer has a manual override or explicit static role, physics must NOT move it.
                const currOverride = getOverride(curr.id, feedback, strategy);
                if (currOverride) continue;

                const prevEnd = prev.coords.x + prev.coords.w;
                
                if (curr.coords.x < prevEnd + padding) {
                    const diff = (prevEnd + padding) - curr.coords.x;
                    curr.coords.x += diff;
                    curr.transform.offsetX += diff;
                }
            }
        }

        // D. Construct Payload
        const payload: TransformedPayload = {
            status: 'success',
            sourceNodeId: nodeId,
            sourceContainer: sourceData.container.containerName,
            targetContainer: targetData.name,
            layers: transformedLayers,
            scaleFactor: baseScale,
            metrics: {
                source: { w: srcW, h: srcH },
                target: { w: tgtW, h: tgtH }
            },
            targetBounds: targetData.bounds,
            // Pass through critical flags
            isConfirmed: feedback?.isCommitted || false,
            requiresGeneration: strategy?.method === 'GENERATIVE' || strategy?.method === 'HYBRID',
            sourceReference: sourceData.aiStrategy?.sourceReference,
            generationId: sourceData.aiStrategy?.timestamp || Date.now(), // Use strategy timestamp to version the  transform
            previewUrl: sourceData.previewUrl,
            triangulation: strategy?.triangulation
        };

        registerPayload(nodeId, `result-out-${index}`, payload);

    }, [sourceData, targetData, strategy, feedback, nodeId, index, registerPayload]);

    const isConnected = !!sourceData && !!targetData;
    const hasStrategy = !!strategy;
    const hasFeedback = !!feedback;

    return (
        <div className={`relative p-2 border-b border-slate-700/50 flex items-center justify-between ${isConnected ? 'bg-slate-800/50' : 'bg-slate-900/50 opacity-50'}`}>
            <Handle type="target" position={Position.Left} id={`source-in-${index}`} className="!absolute !-left-2 !top-4 !w-3 !h-3 !rounded-full !bg-indigo-500 !border-2 !border-slate-800" title="Input: Content Source" />
            <Handle type="target" position={Position.Left} id={`target-in-${index}`} className="!absolute !-left-2 !top-8 !w-3 !h-3 !rounded-full !bg-emerald-500 !border-2 !border-slate-800" title="Input: Target Bounds" />

            <div className="flex flex-col ml-3 overflow-hidden w-full">
                <div className="flex items-center space-x-2">
                    <span className="text-[10px] font-bold text-slate-300 truncate">
                        {targetData?.name || `Slot ${index + 1}`}
                    </span>
                    {hasStrategy && (
                        <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-purple-900/30 border border-purple-500/30">
                            <Cpu className="w-2.5 h-2.5 text-purple-400" />
                            <span className="text-[8px] text-purple-300 font-mono">AI</span>
                        </div>
                    )}
                    {hasFeedback && (
                        <div className="flex items-center space-x-1 px-1.5 py-0.5 rounded bg-blue-900/30 border border-blue-500/30">
                            <Sliders className="w-2.5 h-2.5 text-blue-400" />
                            <span className="text-[8px] text-blue-300 font-mono">FIX</span>
                        </div>
                    )}
                </div>
                <div className="flex items-center space-x-1 mt-1">
                    <span className="text-[9px] text-slate-500 truncate max-w-[80px]">
                        {sourceData?.container.containerName || 'No Source'}
                    </span>
                    <ArrowRightLeft className="w-2.5 h-2.5 text-slate-600" />
                    <span className="text-[9px] text-slate-500 truncate max-w-[80px]">
                        {targetData ? `${Math.round(targetData.bounds.w)}x${Math.round(targetData.bounds.h)}` : 'No Target'}
                    </span>
                </div>
            </div>

            <Handle type="source" position={Position.Right} id={`result-out-${index}`} className="!absolute !-right-2 !top-1/2 !-translate-y-1/2 !w-3 !h-3 !rounded-full !bg-indigo-500 !border-2 !border-white" title="Output: Transformed Payload" />
        </div>
    );
});

export const RemapperNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
  const instanceCount = data.instanceCount || 1;
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const { unregisterNode } = useProceduralStore();

  useEffect(() => {
    return () => unregisterNode(id);
  }, [id, unregisterNode]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, instanceCount, updateNodeInternals]);

  const addInstance = useCallback(() => {
      setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, instanceCount: instanceCount + 1 } } : n));
  }, [id, instanceCount, setNodes]);

  return (
    <div className="w-[300px] bg-slate-800 rounded-lg shadow-2xl border border-indigo-500/50 font-sans flex flex-col transition-all hover:border-indigo-400">
      <NodeResizer minWidth={300} minHeight={200} isVisible={true} lineStyle={{ border: 'none' }} handleStyle={{ background: 'transparent', border: 'none' }} />
      
      {/* Header */}
      <div className="bg-indigo-950/50 p-2 border-b border-indigo-500/30 flex items-center justify-between shrink-0 rounded-t-lg">
         <div className="flex items-center space-x-2">
           <Box className="w-4 h-4 text-indigo-400" />
           <div className="flex flex-col leading-none">
             <span className="text-sm font-bold text-indigo-100">Layout Remapper</span>
             <span className="text-[9px] text-indigo-400 font-mono tracking-wide">TRANSFORM ENGINE</span>
           </div>
         </div>
      </div>

      <div className="flex flex-col">
          {Array.from({ length: instanceCount }).map((_, i) => (
              <RemapperInstanceRow key={i} index={i} nodeId={id} />
          ))}
      </div>

      <button onClick={addInstance} className="w-full py-1.5 bg-slate-900 hover:bg-slate-700 border-t border-slate-700 text-slate-500 hover:text-indigo-300 transition-colors flex items-center justify-center space-x-1 rounded-b-lg">
        <span className="text-[9px] font-bold uppercase tracking-wider">+ Add Transform Slot</span>
      </button>
    </div>
  );
});