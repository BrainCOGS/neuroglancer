/**
 * @license
 * Copyright 2018 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @file User interface for display and editing annotations.
 */

import './annotations.css';

import {Annotation, AnnotationReference, AnnotationSource, annotationToJson, AnnotationType, annotationTypeHandlers, AxisAlignedBoundingBox, Ellipsoid, Line,makeAnnotationId, Point} from 'neuroglancer/annotation';
import {AnnotationDisplayState, AnnotationLayerState} from 'neuroglancer/annotation/annotation_layer_state';
import {MultiscaleAnnotationSource} from 'neuroglancer/annotation/frontend_source';
import {AnnotationLayer, PerspectiveViewAnnotationLayer, SliceViewAnnotationLayer} from 'neuroglancer/annotation/renderlayer';
import {SpatiallyIndexedPerspectiveViewAnnotationLayer, SpatiallyIndexedSliceViewAnnotationLayer} from 'neuroglancer/annotation/renderlayer';
import {CoordinateSpace} from 'neuroglancer/coordinate_transform';
import {MouseSelectionState, UserLayer} from 'neuroglancer/layer';
import {LoadedDataSubsource} from 'neuroglancer/layer_data_source';
import {ChunkTransformParameters, getChunkPositionFromCombinedGlobalLocalPositions} from 'neuroglancer/render_coordinate_transform';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {RenderLayerRole} from 'neuroglancer/renderlayer';
import {getCssColor} from 'neuroglancer/segment_color';
import {getBaseObjectColor, SegmentationDisplayState, updateIdStringWidth} from 'neuroglancer/segmentation_display_state/frontend';
import {ElementVisibilityFromTrackableBoolean} from 'neuroglancer/trackable_boolean';
import {AggregateWatchableValue, makeCachedLazyDerivedWatchableValue, observeWatchable, registerNested, TrackableValueInterface, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {getDefaultSelectBindings} from 'neuroglancer/ui/default_input_event_bindings';
import {registerTool, Tool} from 'neuroglancer/ui/tool';
import {arraysEqual, gatherUpdate} from 'neuroglancer/util/array';
import {setClipboard} from 'neuroglancer/util/clipboard';
import {Borrowed, disposableOnce, Owned, RefCounted} from 'neuroglancer/util/disposable';
import {removeChildren, removeFromParent, updateChildren} from 'neuroglancer/util/dom';
import {ValueOrError} from 'neuroglancer/util/error';
// import {mat4, transformVectorByMat4, vec3} from 'neuroglancer/util/geom';
import {vec3} from 'neuroglancer/util/geom';

import {verifyInt, verifyObject, verifyObjectProperty, verifyOptionalObjectProperty, verifyString} from 'neuroglancer/util/json';
import {EventActionMap, KeyboardEventBinder, registerActionListener} from 'neuroglancer/util/keyboard_bindings';
import * as matrix from 'neuroglancer/util/matrix';
import {MouseEventBinder} from 'neuroglancer/util/mouse_bindings';
import {formatScaleWithUnitAsString} from 'neuroglancer/util/si_units';
import {NullarySignal, observeSignal} from 'neuroglancer/util/signal';
import {formatIntegerBounds, formatIntegerPoint} from 'neuroglancer/util/spatial_units';
import {Uint64} from 'neuroglancer/util/uint64';
import * as vector from 'neuroglancer/util/vector';
import {makeAddButton} from 'neuroglancer/widget/add_button';
import {ColorWidget} from 'neuroglancer/widget/color';
import {makeCopyButton} from 'neuroglancer/widget/copy_button';
import {makeDeleteButton} from 'neuroglancer/widget/delete_button';
import {DependentViewWidget} from 'neuroglancer/widget/dependent_view_widget';
import {makeFilterButton} from 'neuroglancer/widget/filter_button';
import {makeIcon} from 'neuroglancer/widget/icon';
import {makeMoveToButton} from 'neuroglancer/widget/move_to_button';
import {Tab} from 'neuroglancer/widget/tab_view';

// import { SegmentLabelMap } from '../segmentation_display_state/property_map';

const Papa = require('papaparse');

interface AnnotationIdAndPart {
  id: string, sourceIndex: number;
  subsource?: string;
  partIndex?: number
}

export class MergedAnnotationStates extends RefCounted implements
    WatchableValueInterface<readonly AnnotationLayerState[]> {
  changed = new NullarySignal();
  isLoadingChanged = new NullarySignal();
  states: Borrowed<AnnotationLayerState>[] = [];
  relationships: string[] = [];
  private loadingCount = 0;

  get value() {
    return this.states;
  }

  get isLoading() {
    return this.loadingCount !== 0;
  }

  markLoading() {
    this.loadingCount++;
    return () => {
      if (--this.loadingCount === 0) {
        this.isLoadingChanged.dispatch();
      }
    };
  }

  private sort() {
    this.states.sort((a, b) => {
      let d = a.sourceIndex - b.sourceIndex;
      if (d !== 0) return d;
      return a.subsourceIndex - b.subsourceIndex;
    });
  }

  private updateRelationships() {
    const newRelationships = new Set<string>();
    for (const state of this.states) {
      for (const relationship of state.source.relationships) {
        newRelationships.add(relationship);
      }
    }
    this.relationships = Array.from(newRelationships);
  }

  add(state: Borrowed<AnnotationLayerState>) {
    this.states.push(state);
    this.sort();
    this.updateRelationships();
    this.changed.dispatch();
    return () => {
      const index = this.states.indexOf(state);
      this.states.splice(index, 1);
      this.updateRelationships();
      this.changed.dispatch();
    };
  }
}

export class SelectedAnnotationState extends RefCounted implements
    TrackableValueInterface<AnnotationIdAndPart|undefined> {
  private value_: AnnotationIdAndPart|undefined = undefined;
  changed = new NullarySignal();

  private annotationLayer_: AnnotationLayerState|undefined = undefined;
  private reference_: Owned<AnnotationReference>|undefined = undefined;

  get reference() {
    return this.reference_;
  }

  constructor(public annotationStates: Borrowed<MergedAnnotationStates>) {
    super();
    this.registerDisposer(annotationStates.isLoadingChanged.add(this.validate));
  }

  get selectedAnnotationLayer(): AnnotationLayerState|undefined {
    return this.annotationLayer_;
  }

  get value() {
    this.validate();
    return this.value_;
  }

  get validValue() {
    this.validate();
    return this.annotationLayer_ && this.value_;
  }

  set value(value: AnnotationIdAndPart|undefined) {
    if (this.value_ === value) return;
    this.value_ = value;
    if (value === undefined) {
      this.unbindReference();
      this.changed.dispatch();
      return;
    }
    const reference = this.reference_;
    if (reference !== undefined) {
      const annotationLayer = this.annotationLayer_!;
      if (value === undefined || reference.id !== value.id ||
          annotationLayer.sourceIndex !== value.sourceIndex ||
          (annotationLayer.subsourceId !== undefined &&
           annotationLayer.subsourceId !== value.subsource)) {
        this.unbindReference();
      }
    }
    this.validate();
    this.changed.dispatch();
  }

  disposed() {
    this.unbindReference();
    super.disposed();
  }

  private unbindReference() {
    const reference = this.reference_;
    if (reference !== undefined) {
      reference.changed.remove(this.referenceChanged);
      const annotationLayer = this.annotationLayer_!;
      annotationLayer.source.changed.remove(this.validate);
      annotationLayer.dataSource.layer.dataSourcesChanged.remove(this.validate);
      this.reference_ = undefined;
      this.annotationLayer_ = undefined;
    }
  }

  private referenceChanged = (() => {
    this.validate();
    this.changed.dispatch();
  });

  private validate = (() => {
    const value = this.value_;
    if (value === undefined) return;
    const {annotationLayer_} = this;
    const {annotationStates} = this;
    if (annotationLayer_ !== undefined) {
      if (!annotationStates.states.includes(annotationLayer_)) {
        // Annotation layer containing selected annotation was removed.
        this.unbindReference();
        if (!annotationStates.isLoading) {
          this.value_ = undefined;
          this.changed.dispatch();
        }
        return;
      }
      // Existing reference is still valid.
      const reference = this.reference_!;
      let hasChange = false;
      if (reference.id !== value.id) {
        // Id changed.
        value.id = reference.id;
        hasChange = true;
      }
      const {dataSource} = annotationLayer_;
      if (dataSource.layer.dataSources[value.sourceIndex] !== dataSource) {
        value.sourceIndex = annotationLayer_.sourceIndex;
        hasChange = true;
      }
      if (hasChange) this.changed.dispatch();
      return;
    }
    const newAnnotationLayer = annotationStates.states.find(
        x => x.sourceIndex === value.sourceIndex &&
            (value.subsource === undefined || x.subsourceId === value.subsource));
    if (newAnnotationLayer === undefined) {
      if (!annotationStates.isLoading) {
        this.value_ = undefined;
        this.changed.dispatch();
      }
      return;
    }
    this.annotationLayer_ = newAnnotationLayer;
    const reference = this.reference_ = newAnnotationLayer!.source.getReference(value.id);
    reference.changed.add(this.referenceChanged);
    newAnnotationLayer.source.changed.add(this.validate);
    newAnnotationLayer.dataSource.layer.dataSourcesChanged.add(this.validate);
    this.changed.dispatch();
  });

  toJSON() {
    const value = this.value_;
    if (value === undefined) {
      return undefined;
    }
    let partIndex: number|undefined = value.partIndex;
    if (partIndex === 0) partIndex = undefined;
    let sourceIndex: number|undefined = value.sourceIndex;
    if (sourceIndex === 0) sourceIndex = undefined;
    return {id: value.id, partIndex, source: sourceIndex, subsource: value.subsource};
  }
  reset() {
    this.value = undefined;
  }
  restoreState(x: any) {
    if (x === undefined) {
      this.value = undefined;
      return;
    }
    if (typeof x === 'string') {
      this.value = {'id': x, 'partIndex': 0, sourceIndex: 0};
      return;
    }
    verifyObject(x);
    this.value = {
      id: verifyObjectProperty(x, 'id', verifyString),
      partIndex: verifyOptionalObjectProperty(x, 'partIndex', verifyInt),
      sourceIndex: verifyOptionalObjectProperty(x, 'source', verifyInt, 0),
      subsource: verifyOptionalObjectProperty(x, 'subsource', verifyString),
    };
  }
}

function makePointLink(
    chunkPosition: Float32Array, chunkTransform: ChunkTransformParameters,
    setViewPosition?: (layerPosition: Float32Array) => void) {
  const layerRank = chunkTransform.layerRank;
  const layerPosition = new Float32Array(layerRank);
  const paddedChunkPosition = new Float32Array(layerRank);
  paddedChunkPosition.set(chunkPosition);
  matrix.transformPoint(
      layerPosition, chunkTransform.chunkToLayerTransform, layerRank + 1, paddedChunkPosition,
      layerRank);
  const positionText = formatIntegerPoint(layerPosition);
  if (setViewPosition !== undefined) {
    const element = document.createElement('span');
    element.className = 'neuroglancer-voxel-coordinates-link';
    element.textContent = positionText;
    element.title = `Center view on coordinates ${positionText}.`;
    element.addEventListener('click', () => {
      setViewPosition(layerPosition);
    });
    return element;
  } else {
    return document.createTextNode(positionText);
  }
}

export function getPositionSummary(
    element: HTMLElement, annotation: Annotation, chunkTransform: ChunkTransformParameters,
    setViewPosition?: (layerPosition: Float32Array) => void) {
  const makePointLinkWithTransform = (point: Float32Array) =>
      makePointLink(point, chunkTransform, setViewPosition);

  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      element.appendChild(makePointLinkWithTransform(annotation.pointA));
      element.appendChild(document.createTextNode('–'));
      element.appendChild(makePointLinkWithTransform(annotation.pointB));
      break;
    case AnnotationType.POINT:
      element.appendChild(makePointLinkWithTransform(annotation.point));
      break;
    case AnnotationType.ELLIPSOID:
      element.appendChild(makePointLinkWithTransform(annotation.center));
      const rank = chunkTransform.layerRank;
      const layerRadii = new Float32Array(rank);
      matrix.transformVector(
          layerRadii, chunkTransform.chunkToLayerTransform, rank + 1, annotation.radii, rank);
      element.appendChild(document.createTextNode('±' + formatIntegerBounds(layerRadii)));
      break;
  }
}

function getCenterPosition(center: Float32Array, annotation: Annotation) {
  switch (annotation.type) {
    case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
    case AnnotationType.LINE:
      vector.add(center, annotation.pointA, annotation.pointB);
      vector.scale(center, center, 0.5);
      break;
    case AnnotationType.POINT:
      center.set(annotation.point);
      break;
    case AnnotationType.ELLIPSOID:
      center.set(annotation.center);
      break;
  }
}


function setLayerPosition(
    layer: UserLayer, chunkTransform: ValueOrError<ChunkTransformParameters>,
    layerPosition: Float32Array) {
  if (chunkTransform.error !== undefined) return;
  const {globalPosition} = layer.manager.root;
  const {localPosition} = layer;
  const {modelTransform} = chunkTransform;
  gatherUpdate(globalPosition.value, layerPosition, modelTransform.globalToRenderLayerDimensions);
  gatherUpdate(localPosition.value, layerPosition, modelTransform.localToRenderLayerDimensions);
  localPosition.changed.dispatch();
  globalPosition.changed.dispatch();
}


function visitTransformedAnnotationGeometry(
    annotation: Annotation, chunkTransform: ChunkTransformParameters,
    callback: (layerPosition: Float32Array, isVector: boolean) => void) {
  const {layerRank} = chunkTransform;
  const paddedChunkPosition = new Float32Array(layerRank);
  annotationTypeHandlers[annotation.type].visitGeometry(annotation, (chunkPosition, isVector) => {
    // Rank of "chunk" coordinate space may be less than rank of layer space if the annotations are
    // embedded in a higher-dimensional space.  The extra embedding dimensions always are last and
    // have a coordinate of 0.
    paddedChunkPosition.set(chunkPosition);
    const layerPosition = new Float32Array(layerRank);
    (isVector ? matrix.transformVector : matrix.transformPoint)(
        layerPosition, chunkTransform.chunkToLayerTransform, layerRank + 1, paddedChunkPosition,
        layerRank);
    callback(layerPosition, isVector);
  });
}

interface AnnotationLayerViewAttachedState {
  refCounted: RefCounted;
  listElements: Map<string, HTMLElement>;
  sublistContainer: HTMLElement;
}

export class AnnotationLayerView extends Tab {
  private previousSelectedId: string|undefined = undefined;
  private previousSelectedAnnotationLayerState: AnnotationLayerState|undefined = undefined;
  private previousHoverId: string|undefined = undefined;
  private previousHoverAnnotationLayerState: AnnotationLayerState|undefined = undefined;

  private listContainer = document.createElement('div');
  private updated = false;
  private mutableControls = document.createElement('div');
  private headerRow = document.createElement('div');

  get annotationStates() {
    return this.state.annotationStates;
  }

  private attachedAnnotationStates =
      new Map<AnnotationLayerState, AnnotationLayerViewAttachedState>();

  private updateAttachedAnnotationLayerStates() {
    const states = this.annotationStates.states;
    const {attachedAnnotationStates} = this;
    const newAttachedAnnotationStates =
        new Map<AnnotationLayerState, AnnotationLayerViewAttachedState>();
    for (const [state, info] of attachedAnnotationStates) {
      if (!states.includes(state)) {
        attachedAnnotationStates.delete(state);
        info.listElements.clear();
        info.refCounted.dispose();
      }
    }
    for (const state of states) {
      const info = attachedAnnotationStates.get(state);
      if (info !== undefined) {
        newAttachedAnnotationStates.set(state, info);
        continue;
      }
      const source = state.source;
      const refCounted = new RefCounted();
      if (source instanceof AnnotationSource) {
        refCounted.registerDisposer(
            source.childAdded.add((annotation) => this.addAnnotationElement(annotation, state)));
        refCounted.registerDisposer(source.childUpdated.add(
            (annotation) => this.updateAnnotationElement(annotation, state)));
        refCounted.registerDisposer(source.childDeleted.add(
            (annotationId) => this.deleteAnnotationElement(annotationId, state)));
      }
      refCounted.registerDisposer(state.transform.changed.add(this.forceUpdateView));
      const sublistContainer = document.createElement('div');
      sublistContainer.classList.add('neuroglancer-annotation-sublist');
      newAttachedAnnotationStates.set(
          state, {refCounted, listElements: new Map(), sublistContainer});
    }
    this.attachedAnnotationStates = newAttachedAnnotationStates;
    attachedAnnotationStates.clear();
    this.updateCoordinateSpace();
    this.forceUpdateView();
  }

  private forceUpdateView = () => {
    this.updated = false;
    this.updateView();
  };

  private globalDimensionIndices: number[] = [];
  private localDimensionIndices: number[] = [];
  private curCoordinateSpaceGeneration = -1;
  private prevCoordinateSpaceGeneration = -1;

  private updateCoordinateSpace() {
    const localCoordinateSpace = this.layer.localCoordinateSpace.value;
    const globalCoordinateSpace = this.layer.manager.root.coordinateSpace.value;
    const globalDimensionIndices: number[] = [];
    const localDimensionIndices: number[] = [];
    for (let globalDim = 0, globalRank = globalCoordinateSpace.rank; globalDim < globalRank;
         ++globalDim) {
      if (this.annotationStates.states.some(state => {
            const transform = state.transform.value;
            if (transform.error !== undefined) return false;
            return transform.globalToRenderLayerDimensions[globalDim] !== -1;
          })) {
        globalDimensionIndices.push(globalDim);
      }
    }
    for (let localDim = 0, localRank = localCoordinateSpace.rank; localDim < localRank;
         ++localDim) {
      if (this.annotationStates.states.some(state => {
            const transform = state.transform.value;
            if (transform.error !== undefined) return false;
            return transform.localToRenderLayerDimensions[localDim] !== -1;
          })) {
        localDimensionIndices.push(localDim);
      }
    }
    if (!arraysEqual(globalDimensionIndices, this.globalDimensionIndices) ||
        !arraysEqual(localDimensionIndices, this.localDimensionIndices)) {
      this.localDimensionIndices = localDimensionIndices;
      this.globalDimensionIndices = globalDimensionIndices;
      ++this.curCoordinateSpaceGeneration;
    }
  }

  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>, public displayState: AnnotationDisplayState) {
    super();
    this.element.classList.add('neuroglancer-annotation-layer-view');
    this.listContainer.classList.add('neuroglancer-annotation-list');
    this.registerDisposer(state);
    this.registerDisposer(this.visibility.changed.add(() => this.updateView()));
    this.registerDisposer(
        state.annotationStates.changed.add(() => this.updateAttachedAnnotationLayerStates()));
    this.headerRow.classList.add('neuroglancer-annotation-list-header');

    const toolbox = document.createElement('div');
    toolbox.className = 'neuroglancer-annotation-toolbox';

    const exportToCSVButton = document.createElement('button');
    exportToCSVButton.id = 'exportToCSVButton';
    exportToCSVButton.textContent = 'Export to CSV';
    exportToCSVButton.addEventListener('click', () => {
        this.exportToCSV();
      });

    const importCSVButton = document.createElement('button');
    // const importCSVForm = document.createElement('form');
    const importCSVFileSelect = document.createElement('input');
    importCSVButton.id = 'importCSVButton';
    importCSVButton.textContent = 'Import from CSV';
    importCSVFileSelect.type = 'file';
    importCSVFileSelect.accept = 'text/csv';
    importCSVFileSelect.multiple = true;
    importCSVButton.addEventListener('click', () => {
        importCSVFileSelect.click();
      });
    // importCSVForm.appendChild(importCSVFileSelect);
    importCSVFileSelect.addEventListener('change', () => {
      this.importCSV(importCSVFileSelect.files);
    //   importCSVForm.reset();
    });
    // importCSVFileSelect.classList.add('neuroglancer-hidden-button');
    const csvContainer = document.createElement('span');
    csvContainer.append(exportToCSVButton, importCSVButton);
    // this.groupAnnotations.appendFixedChild(csvContainer);

    layer.initializeAnnotationLayerViewTab(this);
    const colorPicker = this.registerDisposer(new ColorWidget(this.displayState.color));
    colorPicker.element.title = 'Change annotation display color';
    this.registerDisposer(new ElementVisibilityFromTrackableBoolean(
        makeCachedLazyDerivedWatchableValue(
            shader => shader.match(/\bdefaultColor\b/) !== null,
            displayState.shaderControls.processedFragmentMain),
        colorPicker.element));
    toolbox.appendChild(colorPicker.element);
    const {mutableControls} = this;
    const pointButton = makeIcon({
      text: annotationTypeHandlers[AnnotationType.POINT].icon,
      title: 'Annotate point',
      onClick: () => {
        this.layer.tool.value = new PlacePointTool(this.layer, {});
      },
    });
    mutableControls.appendChild(pointButton);

    const boundingBoxButton = makeIcon({
      text: annotationTypeHandlers[AnnotationType.AXIS_ALIGNED_BOUNDING_BOX].icon,
      title: 'Annotate bounding box',
      onClick: () => {
        this.layer.tool.value = new PlaceBoundingBoxTool(this.layer, {});
      },
    });
    mutableControls.appendChild(boundingBoxButton);

    const lineButton = makeIcon({
      text: annotationTypeHandlers[AnnotationType.LINE].icon,
      title: 'Annotate line',
      onClick: () => {
        this.layer.tool.value = new PlaceLineTool(this.layer, {});
      },
    });
    mutableControls.appendChild(lineButton);

    const ellipsoidButton = makeIcon({
      text: annotationTypeHandlers[AnnotationType.ELLIPSOID].icon,
      title: 'Annotate ellipsoid',
      onClick: () => {
        this.layer.tool.value = new PlaceEllipsoidTool(this.layer, {});
      },
    });
    mutableControls.appendChild(ellipsoidButton);
    toolbox.appendChild(mutableControls);
    this.element.appendChild(toolbox);
    this.element.appendChild(csvContainer);

    this.element.appendChild(this.listContainer);
    this.listContainer.addEventListener('mouseleave', () => {
      this.displayState.hoverState.value = undefined;
    });

    this.registerDisposer(new MouseEventBinder(this.listContainer, getDefaultSelectBindings()));
    this.registerDisposer(this.displayState.hoverState.changed.add(() => this.updateHoverView()));
    this.registerDisposer(this.state.changed.add(() => this.updateSelectionView()));
    this.registerDisposer(this.layer.localCoordinateSpace.changed.add(() => {
      this.updateCoordinateSpace();
      this.updateView();
    }));
    this.registerDisposer(this.layer.manager.root.coordinateSpace.changed.add(() => {
      this.updateCoordinateSpace();
      this.updateView();
    }));
    this.updateCoordinateSpace();
    this.updateAttachedAnnotationLayerStates();
  }

  private clearSelectionClass() {
    const {previousSelectedAnnotationLayerState, previousSelectedId} = this;
    if (previousSelectedAnnotationLayerState !== undefined) {
      this.previousSelectedAnnotationLayerState = undefined;
      this.previousSelectedId = undefined;
      const attached = this.attachedAnnotationStates.get(previousSelectedAnnotationLayerState);
      if (attached === undefined) return;
      const element = attached.listElements.get(previousSelectedId!);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-selected');
      }
    }
  }

  private exportToCSV() {
    const filename = 'annotations.csv';
    const columnHeaders = [
      'Coordinate 1','Coordinate 2','Ellipsoid Dimensions','Description','Segment IDs','Segment Names','Type']
    const csvData: string[][] = [];
    const self = this;
  
    /// Try to get the segment label mapping
    let annotationLayer = this.annotationStates.states[0];
    let segmentationState = annotationLayer.displayState.relationshipStates.get("segments").segmentationState
    let mapping = segmentationState.value?.segmentLabelMap.value;

    // Loop over annotations
    for (const [state, ] of self.attachedAnnotationStates) {
      if (state.chunkTransform.value.error !== undefined) continue;
      for (const annotation of state.source) {
        const annotationRow = [];
        let coordinate1String = '';
        let coordinate2String = '';
        let ellipsoidDimensions = '';
        let stringType = '';
        // Coordinates and annotation type
        switch (annotation.type) {
          case AnnotationType.POINT:
            stringType = 'Point';
            coordinate1String = formatIntegerPoint(annotation.point);
            break;
          case AnnotationType.ELLIPSOID:
              stringType = 'Ellipsoid';
              coordinate1String =
                  formatIntegerPoint(annotation.center);
              ellipsoidDimensions = formatIntegerPoint(annotation.radii);
              break;
            case AnnotationType.AXIS_ALIGNED_BOUNDING_BOX:
            case AnnotationType.LINE:
              stringType = annotation.type === AnnotationType.LINE ? 'Line' : 'Bounding Box';
              coordinate1String = formatIntegerPoint(annotation.pointA);
              coordinate2String = formatIntegerPoint(annotation.pointB);
              break;
        }
        annotationRow.push(coordinate1String);
        annotationRow.push(coordinate2String);
        annotationRow.push(ellipsoidDimensions);
        // Description
        if (annotation.description) {
          annotationRow.push(annotation.description);
        }
        else {
          annotationRow.push('');
        }
        // Segment IDs and Names, if available
        if (annotation.relatedSegments) {
          const annotationSegments: string[][] = [[]];
          const annotationSegmentNames: string[][] = [[]];
          let segmentList = annotation.relatedSegments[0]; 
          segmentList.forEach(segmentID => {
            annotationSegments[0].push(segmentID.toString());
            
            if (mapping) {
              let segmentName = mapping.get(segmentID.toString());
              if (segmentName) {
                annotationSegmentNames[0].push(segmentName);
              }
              else {
                annotationSegmentNames[0].push('');
              }
            }
            else {
              annotationSegmentNames[0].push('');
            }
          });
          if (annotationSegments[0].length > 0) {
            annotationRow.push(Papa.unparse(annotationSegments,{delimiter: "; "}));
            annotationRow.push(Papa.unparse(annotationSegmentNames,{delimiter: "; "}));
          }
          else {
            annotationRow.push('');
            annotationRow.push('');
          }
        }
        else {
          annotationRow.push('');
          annotationRow.push('');
        }
        // push the type of annotation and then push the whole row
        annotationRow.push(stringType);
        csvData.push(annotationRow);
      }
    }
    // remove duplicates from csvData - often happens with points
    var uniqueData = csvData.map(ar=>JSON.stringify(ar))
      .filter((itm, idx, arr) => arr.indexOf(itm) === idx)
      .map(str=>JSON.parse(str));
    const papaString = Papa.unparse({'fields':columnHeaders,'data': uniqueData})
    const blob = new Blob([papaString],  { type: 'text/csv;charset=utf-8;'});
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
  private betterPapa = (inputFile: File|Blob): Promise<any> => {
    return new Promise((resolve) => {
      Papa.parse(inputFile, {
        complete: (results: any) => {
          resolve(results);
        }
      });
    });
  }
  private stringToVec3 = (input: string): vec3 => {
    // format: (x, y, z)
    let raw = input.split('');
    raw.shift();
    raw.pop();
    let list = raw.join('');
    let val = list.split(',').map(v => parseInt(v, 10));
    return vec3.fromValues(val[0], val[1], val[2]);
  } 
  // private stringToUint64array = (input: string): Uint64 => {
  //   // format: [24, 25, 18]
  //   let raw = input.split('');
  //   raw.shift();
  //   raw.pop();
  //   let list = raw.join('');
  //   let val = list.split(';').map(v => parseInt(v, 10));
  //   return vec3.fromValues(val[0], val[1], val[2]);
  // } 

  private async importCSV(files: FileList|null) {
    const rawAnnotations = <Annotation[]>[];
    const textToPoint = (point: string) => {
      return this.stringToVec3(point);
    };
    if (!files) {
      return;
    }

    for (const file of files) {
      const rawData = await this.betterPapa(file);
      rawData.data = rawData.data.filter((v: any) => v.join('').length);
      if (!rawData.data.length) {
        continue;
      }
      const annStrings = rawData.data;
      for (let row=1; row<annStrings.length; ++row) {
        const annProps = annStrings[row]; 
        const segmentIDstr = annProps[4];
        const type = annProps[6];
        let raw = <Annotation>{id: makeAnnotationId(), description: annProps[3]};

        switch (type) {
          case 'AABB':
          case 'Line':
            raw.type =
                type === 'Line' ? AnnotationType.LINE : AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;
            (<Line>raw).pointA = textToPoint(annProps[0]);
            (<Line>raw).pointB = textToPoint(annProps[1]);
            break;
          case 'Point':
            raw.type = AnnotationType.POINT;
            (<Point>raw).point = textToPoint(annProps[0]);
            break;
          case 'Ellipsoid':
            raw.type = AnnotationType.ELLIPSOID;
            (<Ellipsoid>raw).center = textToPoint(annProps[0]);
            (<Ellipsoid>raw).radii =
                textToPoint(annProps[2]);
            break;
          default:
            // Do not add annotation row, if it has unexpected type
            console.error(
                `No annotation of type ${type}. Cannot parse ${file.name}:${row} ${annProps}`);
            continue;
          }
        // segment IDs
        if (segmentIDstr) {
          let rawstr = segmentIDstr.split('');
          let clean = rawstr.join('');
          let segmentList = clean.split('; ');
          const relatedSegments: Uint64[][] = [];
          const segments: Uint64[] = [];
          let counter = 0; 
          segmentList.forEach((idString: any) => {
            let idUint64 = Uint64.parseString(String(idString));  
            segments[counter] = idUint64;
            ++counter  
          });
          relatedSegments[0] = segments;
          raw.relatedSegments = relatedSegments;
        }
        rawAnnotations.push(raw);
        }
      let annotationLayer = this.annotationStates.states[0];
      for (const ann of rawAnnotations) {
        annotationLayer.source.add(ann, true);
      } 
    }
  }

  private clearHoverClass() {
    const {previousHoverId, previousHoverAnnotationLayerState} = this;
    if (previousHoverAnnotationLayerState !== undefined) {
      this.previousHoverAnnotationLayerState = undefined;
      this.previousHoverId = undefined;
      const attached = this.attachedAnnotationStates.get(previousHoverAnnotationLayerState);
      if (attached === undefined) return;
      const element = attached.listElements.get(previousHoverId!);
      if (element !== undefined) {
        element.classList.remove('neuroglancer-annotation-hover');
      }
    }
  }

  private updateSelectionView() {
    const selectedValue = this.state.value;
    let newSelectedId: string|undefined;
    let newSelectedAnnotationLayerState: AnnotationLayerState|undefined;
    if (selectedValue !== undefined) {
      newSelectedId = selectedValue.id;
      newSelectedAnnotationLayerState = this.state.selectedAnnotationLayer;
    }
    const {previousSelectedId, previousSelectedAnnotationLayerState} = this;
    if (newSelectedId === previousSelectedId &&
        previousSelectedAnnotationLayerState === newSelectedAnnotationLayerState) {
      return;
    }
    this.clearSelectionClass();
    this.previousSelectedId = newSelectedId;
    this.previousSelectedAnnotationLayerState = newSelectedAnnotationLayerState;
    if (newSelectedId === undefined) return;
    const attached = this.attachedAnnotationStates.get(newSelectedAnnotationLayerState!);
    if (attached === undefined) return;
    const element = attached.listElements.get(newSelectedId);
    if (element === undefined) return;
    element.classList.add('neuroglancer-annotation-selected');
    element.scrollIntoView();
  }

  private updateHoverView() {
    const selectedValue = this.displayState.hoverState.value;
    let newHoverId: string|undefined;
    let newAnnotationLayerState: AnnotationLayerState|undefined;
    if (selectedValue !== undefined) {
      newHoverId = selectedValue.id;
      newAnnotationLayerState = selectedValue.annotationLayerState;
    }
    const {previousHoverId, previousHoverAnnotationLayerState} = this;
    if (newHoverId === previousHoverId &&
        newAnnotationLayerState === previousHoverAnnotationLayerState) {
      return;
    }
    this.clearHoverClass();
    this.previousHoverId = newHoverId;
    this.previousHoverAnnotationLayerState = newAnnotationLayerState;
    if (newHoverId === undefined) return;
    const attached = this.attachedAnnotationStates.get(newAnnotationLayerState!);
    if (attached === undefined) return;
    const element = attached.listElements.get(newHoverId);
    if (element === undefined) return;
    element.classList.add('neuroglancer-annotation-hover');
  }

  private updateView() {
    if (!this.visible) {
      return;
    }
    if (this.curCoordinateSpaceGeneration !== this.prevCoordinateSpaceGeneration) {
      this.updated = false;
      const {headerRow} = this;
      const symbolPlaceholder = document.createElement('div');
      symbolPlaceholder.style.gridColumn = `symbol`;

      const deletePlaceholder = document.createElement('div');
      deletePlaceholder.style.gridColumn = `delete`;

      removeChildren(headerRow);
      headerRow.appendChild(symbolPlaceholder);
      let i = 0;
      const addDimension = (coordinateSpace: CoordinateSpace, dimIndex: number) => {
        const dimWidget = document.createElement('div');
        dimWidget.classList.add('neuroglancer-annotations-view-dimension');
        const name = document.createElement('span');
        name.classList.add('neuroglancer-annotations-view-dimension-name');
        name.textContent = coordinateSpace.names[dimIndex];
        const scale = document.createElement('scale');
        scale.classList.add('neuroglancer-annotations-view-dimension-scale');
        scale.textContent = formatScaleWithUnitAsString(
            coordinateSpace.scales[dimIndex], coordinateSpace.units[dimIndex], {precision: 2});
        dimWidget.appendChild(name);
        dimWidget.appendChild(scale);
        dimWidget.style.gridColumn = `dim ${i + 1}`;
        ++i;
        headerRow.appendChild(dimWidget);
      };
      const globalCoordinateSpace = this.layer.manager.root.coordinateSpace.value;
      for (const globalDim of this.globalDimensionIndices) {
        addDimension(globalCoordinateSpace, globalDim);
      }
      const localCoordinateSpace = this.layer.localCoordinateSpace.value;
      for (const localDim of this.localDimensionIndices) {
        addDimension(localCoordinateSpace, localDim);
      }
      headerRow.appendChild(deletePlaceholder);
      this.listContainer.style.gridTemplateColumns =
          `[symbol] min-content repeat(${i}, [dim] min-content) [delete] min-content`;
      this.prevCoordinateSpaceGeneration = this.curCoordinateSpaceGeneration;
    }
    if (this.updated) {
      return;
    }

    let isMutable = false;
    const self = this;
    function* sublistContainers() {
      yield self.headerRow;
      for (const [state, {sublistContainer, listElements}] of self.attachedAnnotationStates) {
        if (!state.source.readonly) isMutable = true;
        removeChildren(sublistContainer);
        listElements.clear();
        if (state.chunkTransform.value.error !== undefined) continue;
        for (const annotation of state.source) {
          sublistContainer.appendChild(self.makeAnnotationListElement(annotation, state));
        }
        yield sublistContainer;
      }
    }
    updateChildren(this.listContainer, sublistContainers());
    this.mutableControls.style.display = isMutable ? 'contents' : 'none';
    this.resetOnUpdate();
  }

  private addAnnotationElement(annotation: Annotation, state: AnnotationLayerState) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const info = this.attachedAnnotationStates.get(state);
    if (info !== undefined) {
      info.sublistContainer.appendChild(this.makeAnnotationListElement(annotation, state));
    }
    this.resetOnUpdate();
  }

  private updateAnnotationElement(annotation: Annotation, state: AnnotationLayerState) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const info = this.attachedAnnotationStates.get(state);
    if (info !== undefined) {
      const {listElements} = info;
      const element = listElements.get(annotation.id);
      if (element !== undefined) {
        const newElement = this.makeAnnotationListElement(annotation, state);
        info.sublistContainer.replaceChild(newElement, element);
        listElements.set(annotation.id, newElement);
      }
    }
    this.resetOnUpdate();
  }

  private deleteAnnotationElement(annotationId: string, state: AnnotationLayerState) {
    if (!this.visible) {
      this.updated = false;
      return;
    }
    if (!this.updated) {
      this.updateView();
      return;
    }
    const attached = this.attachedAnnotationStates.get(state);
    if (attached !== undefined) {
      let element = attached.listElements.get(annotationId);
      if (element !== undefined) {
        removeFromParent(element);
        attached.listElements.delete(annotationId);
      }
    }
    this.resetOnUpdate();
  }

  private resetOnUpdate() {
    this.clearHoverClass();
    this.clearSelectionClass();
    this.updated = true;
    this.updateHoverView();
    this.updateSelectionView();
  }

  private makeAnnotationListElement(annotation: Annotation, state: AnnotationLayerState) {
    const chunkTransform = state.chunkTransform.value as ChunkTransformParameters;
    const element = document.createElement('div');
    element.classList.add('neuroglancer-annotation-list-entry');
    element.title = 'Click to select, right click to recenter view.';

    const icon = document.createElement('div');
    icon.className = 'neuroglancer-annotation-icon';
    icon.textContent = annotationTypeHandlers[annotation.type].icon;
    icon.classList.add('neuroglancer-annotation-list-entry-highlight');
    element.appendChild(icon);

    let deleteButton: HTMLElement|undefined;

    const maybeAddDeleteButton = () => {
      if (state.source.readonly) return;
      if (deleteButton !== undefined) return;
      deleteButton = makeDeleteButton({
        title: 'Delete annotation',
        onClick: () => {
          const ref = state.source.getReference(annotation.id);
          try {
            state.source.delete(ref);
          } finally {
            ref.dispose();
          }
        },
      });
      deleteButton.classList.add('neuroglancer-annotation-list-entry-delete');
      element.appendChild(deleteButton);
    };

    let numRows = 0;
    visitTransformedAnnotationGeometry(annotation, chunkTransform, (layerPosition, isVector) => {
      isVector;
      ++numRows;
      const position = document.createElement('div');
      position.className = 'neuroglancer-annotation-position';
      element.appendChild(position);
      let i = 0;
      const addDims =
          (viewDimensionIndices: readonly number[], layerDimensionIndices: readonly number[]) => {
            for (const viewDim of viewDimensionIndices) {
              const layerDim = layerDimensionIndices[viewDim];
              if (layerDim !== -1) {
                const coord = Math.floor(layerPosition[layerDim]);
                const coordElement = document.createElement('div');
                coordElement.textContent = coord.toString();
                coordElement.classList.add('neuroglancer-annotation-coordinate');
                coordElement.classList.add('neuroglancer-annotation-list-entry-highlight');
                coordElement.style.gridColumn = `dim ${i + 1}`;
                position.appendChild(coordElement);
              }
              ++i;
            }
          };
      addDims(
          this.globalDimensionIndices, chunkTransform.modelTransform.globalToRenderLayerDimensions);
      addDims(
          this.localDimensionIndices, chunkTransform.modelTransform.localToRenderLayerDimensions);
      maybeAddDeleteButton();
    });
    if (annotation.description) {
      ++numRows;
      const description = document.createElement('div');
      description.classList.add('neuroglancer-annotation-description');
      description.classList.add('neuroglancer-annotation-list-entry-highlight');
      description.textContent = annotation.description;
      element.appendChild(description);
    }
    icon.style.gridRow = `span ${numRows}`;
    if (deleteButton !== undefined) {
      deleteButton.style.gridRow = `span ${numRows}`;
    }


    const info = this.attachedAnnotationStates.get(state)!;
    info.listElements.set(annotation.id, element);
    element.addEventListener('mouseenter', () => {
      this.displayState.hoverState.value = {
        id: annotation.id,
        partIndex: 0,
        annotationLayerState: state,
      };
      this.layer.selectAnnotation(state, annotation.id, false);
    });
    element.addEventListener('action:select-position', event => {
      event.stopPropagation();
      this.layer.selectAnnotation(state, annotation.id, 'toggle');
    });

    element.addEventListener('mouseup', (event: MouseEvent) => {
      if (event.button === 2) {
        const {layerRank} = chunkTransform;
        const chunkPosition = new Float32Array(layerRank);
        const layerPosition = new Float32Array(layerRank);
        getCenterPosition(chunkPosition, annotation);
        matrix.transformPoint(
            layerPosition, chunkTransform.chunkToLayerTransform, layerRank + 1, chunkPosition,
            layerRank);
        setLayerPosition(this.layer, chunkTransform, layerPosition);
      }
    });

    return element;
  }
}

export class AnnotationTab extends Tab {
  private layerView = this.registerDisposer(
      new AnnotationLayerView(this.layer, this.state.addRef(), this.layer.annotationDisplayState));
  constructor(
      public layer: Borrowed<UserLayerWithAnnotations>,
      public state: Owned<SelectedAnnotationState>) {
    super();
    this.registerDisposer(state);
    const {element} = this;
    element.classList.add('neuroglancer-annotations-tab');
    element.appendChild(this.layerView.element);
  }
}

function getSelectedAssociatedSegments(annotationLayer: AnnotationLayerState) {
  let segments: Uint64[][] = [];
  const {relationships} = annotationLayer.source;
  const {relationshipStates} = annotationLayer.displayState;
  for (let i = 0, count = relationships.length; i < count; ++i) {
    const segmentationState = relationshipStates.get(relationships[i]).segmentationState.value;
    if (segmentationState != null) {
      if (segmentationState.segmentSelectionState.hasSelectedSegment) {
        segments[i] = [segmentationState.segmentSelectionState.selectedSegment.clone()];
        continue;
      }
    }
    segments[i] = [];
  }
  return segments;
}

abstract class PlaceAnnotationTool extends Tool {
  constructor(public layer: UserLayerWithAnnotations, options: any) {
    super();
    options;
  }

  get annotationLayer(): AnnotationLayerState|undefined {
    for (const state of this.layer.annotationStates.states) {
      if (!state.source.readonly) return state;
    }
    return undefined;
  }
}

const ANNOTATE_POINT_TOOL_ID = 'annotatePoint';
const ANNOTATE_LINE_TOOL_ID = 'annotateLine';
const ANNOTATE_BOUNDING_BOX_TOOL_ID = 'annotateBoundingBox';
const ANNOTATE_ELLIPSOID_TOOL_ID = 'annotateSphere';

export class PlacePointTool extends PlaceAnnotationTool {
  trigger(mouseState: MouseSelectionState) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
      if (point === undefined) return;
      const annotation: Annotation = {
        id: '',
        description: '',
        relatedSegments: getSelectedAssociatedSegments(annotationLayer),
        point,
        type: AnnotationType.POINT,
        properties: annotationLayer.source.properties.map(x => x.default),
      };
      const reference = annotationLayer.source.add(annotation, /*commit=*/ true);
      this.layer.selectAnnotation(annotationLayer, reference.id, true);
      reference.dispose();
    }
  }

  get description() {
    return `annotate point`;
  }

  toJSON() {
    return ANNOTATE_POINT_TOOL_ID;
  }
}

function getMousePositionInAnnotationCoordinates(
    mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Float32Array|
    undefined {
  const chunkTransform = annotationLayer.chunkTransform.value;
  if (chunkTransform.error !== undefined) return undefined;
  const chunkPosition = new Float32Array(chunkTransform.modelTransform.unpaddedRank);
  if (!getChunkPositionFromCombinedGlobalLocalPositions(
          chunkPosition, mouseState.position, annotationLayer.localPosition.value,
          chunkTransform.layerRank, chunkTransform.combinedGlobalLocalToChunkTransform)) {
    return undefined;
  }
  return chunkPosition;
}

abstract class TwoStepAnnotationTool extends PlaceAnnotationTool {
  inProgressAnnotation:
      {annotationLayer: AnnotationLayerState, reference: AnnotationReference, disposer: () => void}|
      undefined;

  abstract getInitialAnnotation(
      mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState): Annotation;
  abstract getUpdatedAnnotation(
      oldAnnotation: Annotation, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation;

  trigger(mouseState: MouseSelectionState) {
    const {annotationLayer} = this;
    if (annotationLayer === undefined) {
      // Not yet ready.
      return;
    }
    if (mouseState.active) {
      const updatePointB = () => {
        const state = this.inProgressAnnotation!;
        const reference = state.reference;
        const newAnnotation =
            this.getUpdatedAnnotation(reference.value!, mouseState, annotationLayer);
        if (JSON.stringify(annotationToJson(newAnnotation, annotationLayer.source)) ===
            JSON.stringify(annotationToJson(reference.value!, annotationLayer.source))) {
          return;
        }
        state.annotationLayer.source.update(reference, newAnnotation);
        this.layer.selectAnnotation(annotationLayer, reference.id, true);
      };

      if (this.inProgressAnnotation === undefined) {
        const reference = annotationLayer.source.add(
            this.getInitialAnnotation(mouseState, annotationLayer), /*commit=*/ false);
        this.layer.selectAnnotation(annotationLayer, reference.id, true);
        const mouseDisposer = mouseState.changed.add(updatePointB);
        const disposer = () => {
          mouseDisposer();
          reference.dispose();
        };
        this.inProgressAnnotation = {
          annotationLayer,
          reference,
          disposer,
        };
      } else {
        updatePointB();
        this.inProgressAnnotation.annotationLayer.source.commit(
            this.inProgressAnnotation.reference);
        this.inProgressAnnotation.disposer();
        this.inProgressAnnotation = undefined;
      }
    }
  }

  disposed() {
    this.deactivate();
    super.disposed();
  }

  deactivate() {
    if (this.inProgressAnnotation !== undefined) {
      this.inProgressAnnotation.annotationLayer.source.delete(this.inProgressAnnotation.reference);
      this.inProgressAnnotation.disposer();
      this.inProgressAnnotation = undefined;
    }
  }
}


abstract class PlaceTwoCornerAnnotationTool extends TwoStepAnnotationTool {
  annotationType: AnnotationType.LINE|AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    return <AxisAlignedBoundingBox|Line>{
      id: '',
      type: this.annotationType,
      description: '',
      pointA: point,
      pointB: point,
      properties: annotationLayer.source.properties.map(x => x.default),
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: AxisAlignedBoundingBox|Line, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState): Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    if (point === undefined) return oldAnnotation;
    return {...oldAnnotation, pointB: point};
  }
}

export class PlaceBoundingBoxTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate bounding box`;
  }

  toJSON() {
    return ANNOTATE_BOUNDING_BOX_TOOL_ID;
  }
}
PlaceBoundingBoxTool.prototype.annotationType = AnnotationType.AXIS_ALIGNED_BOUNDING_BOX;

export class PlaceLineTool extends PlaceTwoCornerAnnotationTool {
  get description() {
    return `annotate line`;
  }

  private initialRelationships: Uint64[][]|undefined;

  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const result = super.getInitialAnnotation(mouseState, annotationLayer);
    this.initialRelationships = result.relatedSegments =
        getSelectedAssociatedSegments(annotationLayer);
    return result;
  }

  getUpdatedAnnotation(
      oldAnnotation: Line|AxisAlignedBoundingBox, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const result = super.getUpdatedAnnotation(oldAnnotation, mouseState, annotationLayer);
    const initialRelationships = this.initialRelationships;
    const newRelationships = getSelectedAssociatedSegments(annotationLayer);
    if (initialRelationships === undefined) {
      result.relatedSegments = newRelationships;
    } else {
      result.relatedSegments = Array.from(newRelationships, (newSegments, i) => {
        const initialSegments = initialRelationships[i];
        newSegments =
            newSegments.filter(x => initialSegments.findIndex(y => Uint64.equal(x, y)) === -1);
        return [...initialSegments, ...newSegments];
      });
    }
    return result;
  }

  toJSON() {
    return ANNOTATE_LINE_TOOL_ID;
  }
}
PlaceLineTool.prototype.annotationType = AnnotationType.LINE;

class PlaceEllipsoidTool extends TwoStepAnnotationTool {
  getInitialAnnotation(mouseState: MouseSelectionState, annotationLayer: AnnotationLayerState):
      Annotation {
    const point = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);

    return <Ellipsoid>{
      type: AnnotationType.ELLIPSOID,
      id: '',
      description: '',
      segments: getSelectedAssociatedSegments(annotationLayer),
      center: point,
      radii: vec3.fromValues(0, 0, 0),
      properties: annotationLayer.source.properties.map(x => x.default),
    };
  }

  getUpdatedAnnotation(
      oldAnnotation: Ellipsoid, mouseState: MouseSelectionState,
      annotationLayer: AnnotationLayerState) {
    const radii = getMousePositionInAnnotationCoordinates(mouseState, annotationLayer);
    if (radii === undefined) return oldAnnotation;
    const center = oldAnnotation.center;
    const rank = center.length;
    for (let i = 0; i < rank; ++i) {
      radii[i] = Math.abs(center[i] - radii[i]);
    }
    return <Ellipsoid>{
      ...oldAnnotation,
      radii,
    };
  }
  get description() {
    return `annotate ellipsoid`;
  }

  toJSON() {
    return ANNOTATE_ELLIPSOID_TOOL_ID;
  }
}

registerTool(
    ANNOTATE_POINT_TOOL_ID,
    (layer, options) => new PlacePointTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_BOUNDING_BOX_TOOL_ID,
    (layer, options) => new PlaceBoundingBoxTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_LINE_TOOL_ID,
    (layer, options) => new PlaceLineTool(<UserLayerWithAnnotations>layer, options));
registerTool(
    ANNOTATE_ELLIPSOID_TOOL_ID,
    (layer, options) => new PlaceEllipsoidTool(<UserLayerWithAnnotations>layer, options));

const newRelatedSegmentKeyMap = EventActionMap.fromObject({
  'enter': {action: 'commit'},
  'escape': {action: 'cancel'},
});

function makeRelatedSegmentList(
    listName: string, segments: Uint64[],
    segmentationDisplayState: WatchableValueInterface<SegmentationDisplayState|null|undefined>,
    mutate?: ((newSegments: Uint64[]) => void)|undefined) {
  return new DependentViewWidget(
      segmentationDisplayState, (segmentationDisplayState, parent, context) => {
        const listElement = document.createElement('div');
        listElement.classList.add('neuroglancer-related-segment-list');
        const headerRow = document.createElement('div');
        headerRow.classList.add('neuroglancer-related-segment-list-header');
        const copyButton = makeCopyButton({
          title: `Copy segment IDs`,
          onClick: () => {
            setClipboard(segments.map(x => x.toString()).join(', '));
          },
        });
        headerRow.appendChild(copyButton);
        let headerCheckbox: HTMLInputElement|undefined;
        if (segmentationDisplayState != null) {
          headerCheckbox = document.createElement('input');
          headerCheckbox.type = 'checkbox';
          headerCheckbox.addEventListener('change', () => {
            const {visibleSegments} = segmentationDisplayState;
            const add = segments.some(id => !visibleSegments.has(id));
            for (const id of segments) {
              visibleSegments.set(id, add);
            }
          });
          headerRow.appendChild(headerCheckbox);
        }
        if (mutate !== undefined) {
          const deleteButton = makeDeleteButton({
            title: 'Remove all IDs',
            onClick: () => {
              mutate([]);
            },
          });
          headerRow.appendChild(deleteButton);
        }
        const titleElement = document.createElement('span');
        titleElement.classList.add('neuroglancer-related-segment-list-title');
        titleElement.textContent = listName;
        headerRow.appendChild(titleElement);
        if (mutate !== undefined) {
          const addButton = makeAddButton({
            title: 'Add related segment ID',
            onClick: () => {
              const addContext = new RefCounted();
              const addContextDisposer = context.registerDisposer(disposableOnce(addContext));
              const newRow = document.createElement('div');
              newRow.classList.add('neuroglancer-segment-list-entry');
              newRow.classList.add('neuroglancer-segment-list-entry-new');
              const copyButton = makeCopyButton({});
              copyButton.classList.add('neuroglancer-segment-list-entry-copy');
              newRow.appendChild(copyButton);
              if (segmentationDisplayState != null) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                newRow.appendChild(checkbox);
              }
              const deleteButton = makeDeleteButton({
                title: 'Cancel adding new segment ID',
                onClick: () => {
                  addContextDisposer();
                },
              });
              newRow.appendChild(deleteButton);
              const idElement = document.createElement('input');
              idElement.autocomplete = 'off';
              idElement.spellcheck = false;
              idElement.classList.add('neuroglancer-segment-list-entry-id');
              const keyboardEventBinder = addContext.registerDisposer(
                  new KeyboardEventBinder(idElement, newRelatedSegmentKeyMap));
              keyboardEventBinder.allShortcutsAreGlobal = true;
              const validateInput = () => {
                const id = new Uint64();
                if (id.tryParseString(idElement.value)) {
                  idElement.dataset.valid = 'true';
                  return id;
                } else {
                  idElement.dataset.valid = 'false';
                  return undefined;
                }
              };
              validateInput();
              idElement.addEventListener('input', () => {
                validateInput();
              });
              idElement.addEventListener('blur', () => {
                const id = validateInput();
                if (id !== undefined) {
                  mutate([...segments, id]);
                }
                addContextDisposer();
              });
              registerActionListener(idElement, 'cancel', addContextDisposer);
              registerActionListener(idElement, 'commit', () => {
                const id = validateInput();
                if (id !== undefined) {
                  mutate([...segments, id]);
                }
                addContextDisposer();
              });
              newRow.appendChild(idElement);
              listElement.appendChild(newRow);
              idElement.focus();
              addContext.registerDisposer(() => {
                idElement.value = '';
                newRow.remove();
              });
            },
          });
          headerRow.appendChild(addButton);
        }

        listElement.appendChild(headerRow);

        const rows: {
          id: Uint64,
          row: HTMLElement,
          checkbox: HTMLInputElement|undefined,
          nameElement: HTMLElement,
          filterElement: HTMLElement,
          idElement: HTMLElement
        }[] = [];
        for (const id of segments) {
          const row = document.createElement('div');
          row.classList.add('neuroglancer-segment-list-entry');
          row.addEventListener('click', () => {
            if (segmentationDisplayState != null) {
              segmentationDisplayState.selectSegment(id, true);
            }
          });
          const copyButton = makeCopyButton({
            title: 'Copy segment ID',
            onClick: event => {
              setClipboard(id.toString());
              event.stopPropagation();
            },
          });
          copyButton.classList.add('neuroglancer-segment-list-entry-copy');
          row.appendChild(copyButton);
          let checkbox: HTMLInputElement|undefined;
          if (segmentationDisplayState != null) {
            checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.title = 'Toggle segment visibility';
            checkbox.addEventListener('click', event => {
              const {visibleSegments} = segmentationDisplayState;
              visibleSegments.set(id, !visibleSegments.has(id));
              event.stopPropagation();
            });
            row.appendChild(checkbox);
          }
          if (mutate !== undefined) {
            const deleteButton = makeDeleteButton({
              title: 'Remove ID',
              onClick: event => {
                mutate(segments.filter(x => !Uint64.equal(x, id)));
                event.stopPropagation();
              },
            });
            row.appendChild(deleteButton);
          }
          const idElement = document.createElement('span');
          idElement.classList.add('neuroglancer-segment-list-entry-id');
          const idString = id.toString();
          if (segmentationDisplayState != null) {
            updateIdStringWidth(segmentationDisplayState.maxIdLength, idString);
          }
          idElement.textContent = idString;
          row.appendChild(idElement);
          const filterElement = makeFilterButton({
            title: 'Filter by label',
            onClick: event => {
              if (segmentationDisplayState != null) {
                segmentationDisplayState.filterBySegmentLabel(id);
              }
              event.stopPropagation();
            },
          });
          filterElement.classList.add('neuroglancer-segment-list-entry-filter');
          filterElement.style.visibility = 'hidden';
          row.appendChild(filterElement);
          const nameElement = document.createElement('span');
          nameElement.classList.add('neuroglancer-segment-list-entry-name');
          row.appendChild(nameElement);
          listElement.appendChild(row);
          if (segmentationDisplayState != null) {
            row.addEventListener('mouseenter', () => {
              segmentationDisplayState.segmentSelectionState.set(id);
            });
            row.addEventListener('mouseleave', () => {
              segmentationDisplayState.segmentSelectionState.set(null);
            });
          }
          rows.push({id, row, checkbox, nameElement, idElement, filterElement});
        }

        if (segmentationDisplayState != null) {
          context.registerDisposer(observeWatchable(
              width =>
                  listElement.style.setProperty('--neuroglancer-segment-list-width', `${width}ch`),
              segmentationDisplayState.maxIdLength));
          context.registerDisposer(observeSignal(
              () => {
                const {segmentSelectionState, visibleSegments} = segmentationDisplayState;
                let numVisible = 0;
                for (const {id, row, checkbox} of rows) {
                  row.dataset.selected = (segmentSelectionState.hasSelectedSegment &&
                                          Uint64.equal(segmentSelectionState.selectedSegment, id))
                                             .toString();
                  const visible = checkbox!.checked = visibleSegments.has(id);
                  if (visible) ++numVisible;
                }
                headerCheckbox!.checked = numVisible === segments.length && numVisible > 0;
                headerCheckbox!.indeterminate = (numVisible > 0) && (numVisible < segments.length);
              },
              segmentationDisplayState.visibleSegments.changed,
              segmentationDisplayState.segmentSelectionState.changed));
          context.registerDisposer(observeSignal(
              () => {
                const segmentLabelMap = segmentationDisplayState.segmentLabelMap.value;
                for (const {id, nameElement, idElement, filterElement} of rows) {
                  let name = '';
                  if (segmentLabelMap !== undefined) {
                    name = segmentLabelMap.get(id.toString()) || '';
                  }
                  filterElement.style.visibility = name ? '' : 'hidden';
                  nameElement.textContent = name;
                  idElement.style.backgroundColor =
                      getCssColor(getBaseObjectColor(segmentationDisplayState, id));
                }
              },
              segmentationDisplayState.segmentColorHash.changed,
              segmentationDisplayState.segmentLabelMap.changed));
        }
        parent.appendChild(listElement);
      });
}

const SELECTED_ANNOTATION_JSON_KEY = 'selectedAnnotation';
const ANNOTATION_COLOR_JSON_KEY = 'annotationColor';
export function UserLayerWithAnnotationsMixin<TBase extends {new (...args: any[]): UserLayer}>(
    Base: TBase) {
  abstract class C extends Base implements UserLayerWithAnnotations {
    annotationStates = this.registerDisposer(new MergedAnnotationStates());
    annotationDisplayState = new AnnotationDisplayState();
    selectedAnnotation = this.registerDisposer(new SelectedAnnotationState(this.annotationStates));
    annotationCrossSectionRenderScaleHistogram = new RenderScaleHistogram();
    annotationCrossSectionRenderScaleTarget = trackableRenderScaleTarget(8);
    annotationProjectionRenderScaleHistogram = new RenderScaleHistogram();
    annotationProjectionRenderScaleTarget = trackableRenderScaleTarget(8);

    constructor(...args: any[]) {
      super(...args);
      this.selectedAnnotation.changed.add(this.specificationChanged.dispatch);
      this.annotationDisplayState.color.changed.add(this.specificationChanged.dispatch);
      this.annotationDisplayState.shader.changed.add(this.specificationChanged.dispatch);
      this.annotationDisplayState.shaderControls.changed.add(this.specificationChanged.dispatch);
      this.tabs.add('annotations', {
        label: 'Annotations',
        order: 10,
        getter: () => new AnnotationTab(this, this.selectedAnnotation.addRef())
      });

      let annotationStateReadyBinding: (() => void)|undefined;

      const updateReadyBinding = () => {
        const isReady = this.isReady;
        if (isReady && annotationStateReadyBinding !== undefined) {
          annotationStateReadyBinding();
          annotationStateReadyBinding = undefined;
        } else if (!isReady && annotationStateReadyBinding === undefined) {
          annotationStateReadyBinding = this.annotationStates.markLoading();
        }
      };
      this.readyStateChanged.add(updateReadyBinding);
      updateReadyBinding();

      const {mouseState} = this.manager.layerSelectedValues;
      this.registerDisposer(mouseState.changed.add(() => {
        if (mouseState.active) {
          const {pickedAnnotationLayer} = mouseState;
          if (pickedAnnotationLayer !== undefined &&
              this.annotationStates.states.includes(pickedAnnotationLayer)) {
            const existingValue = this.annotationDisplayState.hoverState.value;
            if (existingValue === undefined || existingValue.id !== mouseState.pickedAnnotationId!
                || existingValue.partIndex !== mouseState.pickedOffset ||
                existingValue.annotationLayerState !== pickedAnnotationLayer) {
              this.annotationDisplayState.hoverState.value = {
                id: mouseState.pickedAnnotationId!,
                partIndex: mouseState.pickedOffset,
                annotationLayerState: pickedAnnotationLayer,
              };
            }
            return;
          }
        }
        this.annotationDisplayState.hoverState.value = undefined;
      }));
    }

    initializeAnnotationLayerViewTab(tab: AnnotationLayerView) {
      tab;
    }

    restoreState(specification: any) {
      super.restoreState(specification);
      this.selectedAnnotation.restoreState(specification[SELECTED_ANNOTATION_JSON_KEY]);
      this.annotationDisplayState.color.restoreState(specification[ANNOTATION_COLOR_JSON_KEY]);
    }

    captureSelectionState(state: this['selectionState'], mouseState: MouseSelectionState) {
      super.captureSelectionState(state, mouseState);
      const annotationLayer = mouseState.pickedAnnotationLayer;
      if (annotationLayer === undefined ||
          !this.annotationStates.states.includes(annotationLayer)) {
        return;
      }
      state.annotationId = mouseState.pickedAnnotationId;
      state.annotationPartIndex = mouseState.pickedOffset;
      state.annotationSourceIndex = annotationLayer.sourceIndex;
      state.annotationSubsource = annotationLayer.subsourceId;
    }

    displayAnnotationState(state: this['selectionState'], parent: HTMLElement, context: RefCounted):
        boolean {
      if (state.annotationId === undefined) return false;
      const annotationLayer = this.annotationStates.states.find(
          x => x.sourceIndex === state.annotationSourceIndex &&
              (state.annotationSubsource === undefined ||
               x.subsourceId === state.annotationSubsource));
      if (annotationLayer === undefined) return false;
      const reference =
          context.registerDisposer(annotationLayer.source.getReference(state.annotationId));
      parent.appendChild(
          context
              .registerDisposer(new DependentViewWidget(
                  context.registerDisposer(
                      new AggregateWatchableValue(() => ({
                                                    annotation: reference,
                                                    chunkTransform: annotationLayer.chunkTransform
                                                  }))),
                  ({annotation, chunkTransform}, parent, context) => {
                    if (annotation == null) {
                      const statusMessage = document.createElement('div');
                      statusMessage.classList.add('neuroglancer-selection-annotation-status');
                      statusMessage.textContent =
                          (annotation === null) ? 'Annotation not found' : 'Loading...';
                      parent.appendChild(statusMessage);
                      return;
                    }
                    const layerRank =
                        chunkTransform.error === undefined ? chunkTransform.layerRank : 0;
                    const positionGrid = document.createElement('div');
                    positionGrid.classList.add(
                        'neuroglancer-selected-annotation-details-position-grid');
                    positionGrid.style.gridTemplateColumns = `[icon] 0fr [copy] 0fr repeat(${
                        layerRank}, [dim] 0fr [coord] 0fr) [move] 0fr [delete] 0fr`;
                    parent.appendChild(positionGrid);

                    const handler = annotationTypeHandlers[annotation.type];
                    const icon = document.createElement('div');
                    icon.className = 'neuroglancer-selected-annotation-details-icon';
                    icon.textContent = handler.icon;
                    positionGrid.appendChild(icon);

                    if (layerRank !== 0) {
                      const {layerDimensionNames} =
                          (chunkTransform as ChunkTransformParameters).modelTransform;
                      for (let i = 0; i < layerRank; ++i) {
                        const dimElement = document.createElement('div');
                        dimElement.classList.add(
                            'neuroglancer-selected-annotation-details-position-dim');
                        dimElement.textContent = layerDimensionNames[i];
                        dimElement.style.gridColumn = `dim ${i + 1}`;
                        positionGrid.appendChild(dimElement);
                      }
                      visitTransformedAnnotationGeometry(
                          annotation, chunkTransform as ChunkTransformParameters,
                          (layerPosition, isVector) => {
                            const copyButton = makeCopyButton({
                              title: 'Copy position',
                              onClick: () => {
                                setClipboard(layerPosition.map(x => Math.floor(x)).join(', '));
                              },
                            });
                            copyButton.style.gridColumn = 'copy';
                            positionGrid.appendChild(copyButton);
                            for (let layerDim = 0; layerDim < layerRank; ++layerDim) {
                              const coordElement = document.createElement('div');
                              coordElement.classList.add(
                                  'neuroglancer-selected-annotation-details-position-coord');
                              coordElement.style.gridColumn = `coord ${layerDim + 1}`;
                              coordElement.textContent =
                                  Math.floor(layerPosition[layerDim]).toString();
                              positionGrid.appendChild(coordElement);
                            }
                            if (!isVector) {
                              const moveButton = makeMoveToButton({
                                title: 'Move to position',
                                onClick: () => {
                                  setLayerPosition(this, chunkTransform, layerPosition);
                                },
                              });
                              moveButton.style.gridColumn = 'move';
                              positionGrid.appendChild(moveButton);
                            }
                          });
                    }

                    if (!annotationLayer.source.readonly) {
                      const button = makeDeleteButton({
                        title: 'Delete annotation',
                        onClick: () => {
                          annotationLayer.source.delete(reference);
                        }
                      });
                      button.classList.add('neuroglancer-selected-annotation-details-delete');
                      positionGrid.appendChild(button);
                    }

                    // if (annotation.type === AnnotationType.AXIS_ALIGNED_BOUNDING_BOX) {
                    //   const volume = document.createElement('div');
                    //   volume.className = 'neuroglancer-annotation-details-volume';
                    //   volume.textContent = formatBoundingBoxVolume(annotation.pointA,
                    //   annotation.pointB, objectToGlobal); element.appendChild(volume);

                    //   // FIXME: only do this if it is axis aligned
                    //   const spatialOffset = transformVectorByMat4(
                    //       tempVec3, vec3.subtract(tempVec3, annotation.pointA,
                    //       annotation.pointB), objectToGlobal);
                    //   const voxelVolume = document.createElement('div');
                    //   voxelVolume.className = 'neuroglancer-annotation-details-volume-in-voxels';
                    //   const voxelOffset = vec3.divide(tempVec3, spatialOffset,
                    //   coordinateSpace!.scales as any);
                    //   // FIXME voxelVolume.textContent = `${formatIntegerBounds(voxelOffset as
                    //   vec3)}`; element.appendChild(voxelVolume);
                    // } else if (annotation.type === AnnotationType.LINE) {
                    //   const spatialOffset = transformVectorByMat4(
                    //       tempVec3, vec3.subtract(tempVec3, annotation.pointA,
                    //       annotation.pointB), objectToGlobal);
                    //   const length = document.createElement('div');
                    //   length.className = 'neuroglancer-annotation-details-length';
                    //   const spatialLengthText = formatLength(vec3.length(spatialOffset));
                    //   let voxelLengthText = '';
                    //   if (coordinateSpace !== undefined) {
                    //     const voxelLength = vec3.length(
                    //         vec3.divide(tempVec3, spatialOffset, coordinateSpace.scales as any)
                    //         as vec3); //
                    //         FIXME
                    //     voxelLengthText = `, ${Math.round(voxelLength)} vx`;
                    //   }
                    //   length.textContent = spatialLengthText + voxelLengthText;
                    //   element.appendChild(length);
                    // }


                    const {relationships, properties} = annotationLayer.source;
                    const sourceReadonly = annotationLayer.source.readonly;
                    const {relatedSegments} = annotation;
                    for (let i = 0, count = relationships.length; i < count; ++i) {
                      const related = relatedSegments === undefined ? [] : relatedSegments[i];
                      if (related.length === 0 && sourceReadonly) continue;
                      const relationshipIndex = i;
                      const relationship = relationships[i];
                      parent.appendChild(
                          context
                              .registerDisposer(makeRelatedSegmentList(
                                  relationship, related,
                                  annotationLayer.displayState.relationshipStates.get(relationship)
                                      .segmentationState,
                                  sourceReadonly ?
                                      undefined :
                                      newIds => {
                                        const annotation = reference.value;
                                        if (annotation == null) {
                                          return;
                                        }
                                        let {relatedSegments} = annotation;
                                        if (relatedSegments === undefined) {
                                          relatedSegments =
                                              annotationLayer.source.relationships.map(() => []);
                                        } else {
                                          relatedSegments = relatedSegments.slice();
                                        }
                                        relatedSegments[relationshipIndex] = newIds;
                                        const newAnnotation = {...annotation, relatedSegments};
                                        annotationLayer.source.update(reference, newAnnotation);
                                        annotationLayer.source.commit(reference);
                                      }))
                              .element);
                    }

                    for (let i = 0, count = properties.length; i < count; ++i) {
                      const property = properties[i];
                      const label = document.createElement('label');
                      label.classList.add('neuroglancer-annotation-property');
                      const idElement = document.createElement('span');
                      idElement.classList.add('neuroglancer-annotation-property-label');
                      idElement.textContent = property.identifier;
                      label.appendChild(idElement);
                      const {description} = property;
                      if (description !== undefined) {
                        label.title = description;
                      }
                      const value = annotation.properties[i];
                      const valueElement = document.createElement('span');
                      valueElement.classList.add('neuroglancer-annotation-property-value');
                      valueElement.textContent =
                          property.type === 'float32' ? value.toPrecision(6) : value.toString();
                      label.appendChild(valueElement);
                      parent.appendChild(label);
                    }

                    if (!annotationLayer.source.readonly || annotation.description) {
                      if (annotationLayer.source.readonly) {
                        const description = document.createElement('div');
                        description.className = 'neuroglancer-annotation-details-description';
                        description.textContent = annotation.description || '';
                        parent.appendChild(description);
                      } else {
                        const description = document.createElement('textarea');
                        description.value = annotation.description || '';
                        description.rows = 3;
                        description.className = 'neuroglancer-annotation-details-description';
                        description.placeholder = 'Description';
                        description.addEventListener('change', () => {
                          const x = description.value;
                          annotationLayer.source.update(
                              reference, {...annotation, description: x ? x : undefined});
                          annotationLayer.source.commit(reference);
                        });
                        parent.appendChild(description);
                      }
                    }
                  }))
              .element);
      return true;
    }


    displaySelectionState(state: this['selectionState'], parent: HTMLElement, context: RefCounted):
        boolean {
      let displayed = this.displayAnnotationState(state, parent, context);
      if (super.displaySelectionState(state, parent, context)) displayed = true;
      return displayed;
    }

    addLocalAnnotations(
        loadedSubsource: LoadedDataSubsource, source: AnnotationSource, role: RenderLayerRole) {
      const {subsourceEntry} = loadedSubsource;
      const state = new AnnotationLayerState({
        localPosition: this.localPosition,
        transform: loadedSubsource.getRenderLayerTransform(),
        source,
        displayState: this.annotationDisplayState,
        dataSource: loadedSubsource.loadedDataSource.layerDataSource,
        subsourceIndex: loadedSubsource.subsourceIndex,
        subsourceId: subsourceEntry.id,
        role,
      });
      this.addAnnotationLayerState(state, loadedSubsource);
    }

    addStaticAnnotations(loadedSubsource: LoadedDataSubsource) {
      const {subsourceEntry} = loadedSubsource;
      const {staticAnnotations} = subsourceEntry.subsource;
      if (staticAnnotations === undefined) return false;
      loadedSubsource.activate(() => {
        this.addLocalAnnotations(
            loadedSubsource, staticAnnotations, RenderLayerRole.DEFAULT_ANNOTATION);
      });
      return true;
    }

    addAnnotationLayerState(state: AnnotationLayerState, loadedSubsource: LoadedDataSubsource) {
      const refCounted = loadedSubsource.activated!;
      refCounted.registerDisposer(this.annotationStates.add(state));
      const annotationLayer = new AnnotationLayer(this.manager.chunkManager, state.addRef());
      if (annotationLayer.source instanceof MultiscaleAnnotationSource) {
        const crossSectionRenderLayer = new SpatiallyIndexedSliceViewAnnotationLayer({
          annotationLayer: annotationLayer.addRef(),
          renderScaleTarget: this.annotationCrossSectionRenderScaleTarget,
          renderScaleHistogram: this.annotationCrossSectionRenderScaleHistogram
        });
        refCounted.registerDisposer(
            loadedSubsource.messages.addChild(crossSectionRenderLayer.messages));

        const projectionRenderLayer = new SpatiallyIndexedPerspectiveViewAnnotationLayer({
          annotationLayer: annotationLayer.addRef(),
          renderScaleTarget: this.annotationProjectionRenderScaleTarget,
          renderScaleHistogram: this.annotationProjectionRenderScaleHistogram
        });
        refCounted.registerDisposer(
            loadedSubsource.messages.addChild(projectionRenderLayer.messages));

        refCounted.registerDisposer(registerNested((context, value) => {
          if (value) {
            context.registerDisposer(this.addRenderLayer(crossSectionRenderLayer.addRef()));
            context.registerDisposer(this.addRenderLayer(projectionRenderLayer.addRef()));
          }
        }, this.annotationDisplayState.displayUnfiltered));
      }
      {
        const renderLayer = new SliceViewAnnotationLayer(
            annotationLayer, this.annotationCrossSectionRenderScaleHistogram);
        refCounted.registerDisposer(this.addRenderLayer(renderLayer));
        refCounted.registerDisposer(loadedSubsource.messages.addChild(renderLayer.messages));
      }
      {
        const renderLayer = new PerspectiveViewAnnotationLayer(
            annotationLayer.addRef(), this.annotationProjectionRenderScaleHistogram);
        refCounted.registerDisposer(this.addRenderLayer(renderLayer));
        refCounted.registerDisposer(loadedSubsource.messages.addChild(renderLayer.messages));
      }
    }

    selectAnnotation(
        annotationLayer: Borrowed<AnnotationLayerState>, id: string, pin: boolean|'toggle') {
      this.manager.root.selectionState.captureSingleLayerState(this, state => {
        state.annotationId = id;
        state.annotationSourceIndex = annotationLayer.sourceIndex;
        state.annotationSubsource = annotationLayer.subsourceId;
        return true;
      }, pin);
    }

    toJSON() {
      const x = super.toJSON();
      x[SELECTED_ANNOTATION_JSON_KEY] = this.selectedAnnotation.toJSON();
      x[ANNOTATION_COLOR_JSON_KEY] = this.annotationDisplayState.color.toJSON();
      return x;
    }
  }
  return C;
}

export type UserLayerWithAnnotations =
    InstanceType<ReturnType<typeof UserLayerWithAnnotationsMixin>>;
