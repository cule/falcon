import { DataBase, DbResult } from "./db";
import { HIST_TYPE, CUM_ARR_TYPE } from "../consts";
import { Table } from "@apache-arrow/es2015-esm";
import ndarray from "ndarray";
import prefixSum from "ndarray-prefix-sum";
import { Dimension, View1D, View2D, Views } from "../api";
import { Interval } from "../basic";
import { BitSet, union } from "../bitset";
import { binNumberFunction, numBins, stepSize } from "../util";

export class ArrowDB<V extends string, D extends string>
  implements DataBase<V, D> {
  private data: Table;

  public constructor(private readonly url: string) {}

  public async initialize() {
    const response = await fetch(this.url);
    const buffer = await response.arrayBuffer();

    this.data = Table.from(new Uint8Array(buffer));

    return;
  }

  private getFilterMask(dimension: D, extent: Interval<number>) {
    const column = this.data.getColumn(dimension)!;
    const mask = new BitSet(column.length);

    for (let i = 0; i < column.length; i++) {
      const val: number = column.get(i);
      if (val < extent[0] || val > extent[1]) {
        mask.set(i, true);
      }
    }

    return mask;
  }

  public length() {
    return Promise.resolve(this.data.length);
  }

  public histogram(dimension: Dimension<D>) {
    console.time("Histogram");

    const binConfig = dimension.binConfig!;
    const bin = binNumberFunction(binConfig);
    const binCount = numBins(binConfig);

    const hist = ndarray(new HIST_TYPE(binCount));
    for (const value of this.data.getColumn(dimension.name)!) {
      const key = bin(value);
      if (0 <= key && key < binCount) {
        hist.data[hist.index(key)]++;
      }
    }

    console.timeEnd("Histogram");

    return Promise.resolve(hist);
  }

  public heatmap(dimensions: [Dimension<D>, Dimension<D>]) {
    console.time("Heatmap");

    const binConfigs = dimensions.map(d => d.binConfig!);
    const [numBinsX, numBinsY] = binConfigs.map(numBins);
    const [binX, binY] = binConfigs.map(binNumberFunction);
    const [columnX, columnY] = dimensions.map(
      d => this.data.getColumn(d.name)!
    );

    const heat = ndarray(new HIST_TYPE(numBinsX * numBinsY), [
      numBinsX,
      numBinsY
    ]);

    for (let i = 0; i < this.data.length; i++) {
      const keyX = binX(columnX.get(i));
      const keyY = binY(columnY.get(i));

      if (0 <= keyX && keyX < numBinsX && 0 <= keyY && keyY < numBinsY) {
        heat.data[heat.index(keyX, keyY)]++;
      }
    }

    console.timeEnd("Heatmap");

    return Promise.resolve(heat);
  }

  private getFilterMasks(brushes: Map<D, Interval<number>>) {
    console.time("Build filter masks");

    const filters = new Map<D, BitSet>();
    for (const [dimension, extent] of brushes) {
      filters.set(dimension, this.getFilterMask(dimension, extent));
    }

    console.timeEnd("Build filter masks");

    return filters;
  }

  public loadData1D(
    activeView: View1D<D>,
    pixels: number,
    views: Views<V, D>,
    brushes: Map<D, Interval<number>>
  ) {
    console.time("Build result cube");

    const filterMasks = this.getFilterMasks(brushes);
    const result: DbResult<V> = new Map();

    const activeDim = activeView.dimension;
    const activeStepSize = stepSize(activeDim.extent, pixels);
    const binActive = binNumberFunction({
      start: activeDim.extent[0] - activeStepSize,
      step: activeStepSize
    });
    const activeCol = this.data.getColumn(activeDim.name)!;
    const numPixels = pixels + 1; // extending by one pixel so we can compute the right diff later

    for (const [name, view] of views) {
      // array for histograms with last histogram being the complete histogram
      let hists: ndarray;
      let noBrush: ndarray;

      // get union of all filter masks that don't contain the dimension(s) for the current view
      const relevantMasks = new Map(filterMasks);
      if (view.type === "0D") {
        // use all filters
      } else if (view.type === "1D") {
        relevantMasks.delete(view.dimension.name);
      } else {
        relevantMasks.delete(view.dimensions[0].name);
        relevantMasks.delete(view.dimensions[1].name);
      }
      const filterMask = union(...relevantMasks.values());

      if (view.type === "0D") {
        hists = ndarray(new CUM_ARR_TYPE(numPixels));
        noBrush = ndarray(new HIST_TYPE(1), [1]);

        // add data to aggregation matrix
        for (let i = 0; i < this.data.length; i++) {
          // ignore filtered entries
          if (filterMask && filterMask.check(i)) {
            continue;
          }

          const keyActive = binActive(activeCol.get(i));
          if (0 <= keyActive && keyActive < numPixels) {
            hists.data[hists.index(keyActive)]++;
          }
          noBrush.data[0]++;
        }

        prefixSum(hists);
      } else if (view.type === "1D") {
        const dim = view.dimension;

        const binConfig = dim.binConfig!;
        const bin = binNumberFunction(binConfig);
        const binCount = numBins(binConfig);

        hists = ndarray(new CUM_ARR_TYPE(numPixels * binCount), [
          numPixels,
          binCount
        ]);
        noBrush = ndarray(new HIST_TYPE(binCount), [binCount]);

        const column = this.data.getColumn(dim.name)!;

        // add data to aggregation matrix
        for (let i = 0; i < this.data.length; i++) {
          // ignore filtered entries
          if (filterMask && filterMask.check(i)) {
            continue;
          }

          const key = bin(column.get(i));
          const keyActive = binActive(activeCol.get(i));
          if (0 <= key && key < binCount) {
            if (0 <= keyActive && keyActive < numPixels) {
              hists.data[hists.index(keyActive, key)]++;
            }
            noBrush.data[key]++;
          }
        }

        // compute cumulative sums
        for (let x = 0; x < hists.shape[1]; x++) {
          prefixSum(hists.pick(null, x));
        }
      } else {
        const dimensions = view.dimensions;
        const binConfigs = dimensions.map(d => d.binConfig!);
        const [numBinsX, numBinsY] = binConfigs.map(numBins);
        const [binX, binY] = binConfigs.map(binNumberFunction);
        const [columnX, columnY] = dimensions.map(
          d => this.data.getColumn(d.name)!
        );

        hists = ndarray(new CUM_ARR_TYPE(numPixels * numBinsX * numBinsY), [
          numPixels,
          numBinsX,
          numBinsY
        ]);
        noBrush = ndarray(new HIST_TYPE(numBinsX * numBinsY), [
          numBinsX,
          numBinsY
        ]);

        for (let i = 0; i < this.data.length; i++) {
          // ignore filtered entries
          if (filterMask && filterMask.check(i)) {
            continue;
          }

          const keyX = binX(columnX.get(i));
          const keyY = binY(columnY.get(i));
          const keyActive = binActive(activeCol.get(i));
          if (0 <= keyX && keyX < numBinsX && 0 <= keyY && keyY < numBinsY) {
            if (0 <= keyActive && keyActive < numPixels) {
              hists.data[hists.index(keyActive, keyX, keyY)]++;
            }
            noBrush.data[noBrush.index(keyX, keyY)]++;
          }
        }

        // compute cumulative sums
        for (let x = 0; x < hists.shape[1]; x++) {
          for (let y = 0; y < hists.shape[2]; y++) {
            prefixSum(hists.pick(null, x, y));
          }
        }
      }

      result.set(name, { hists, noBrush });
    }

    console.timeEnd("Build result cube");

    return result;
  }

  public loadData2D(
    activeView: View2D<D>,
    pixels: [number, number],
    views: Views<V, D>,
    brushes: Map<D, Interval<number>>
  ) {
    console.time("Build result cube");

    const filterMasks = this.getFilterMasks(brushes);
    const result: DbResult<V> = new Map();

    const [activeDimX, activeDimY] = activeView.dimensions;
    const activeStepSizeX = stepSize(activeDimX.extent, pixels[0]);
    const activeStepSizeY = stepSize(activeDimY.extent, pixels[1]);
    const binActiveX = binNumberFunction({
      start: activeDimX.extent[0] - activeStepSizeX,
      step: activeStepSizeX
    });
    const binActiveY = binNumberFunction({
      start: activeDimY.extent[0] - activeStepSizeY,
      step: activeStepSizeY
    });
    const activeColX = this.data.getColumn(activeDimX.name)!;
    const activeColY = this.data.getColumn(activeDimY.name)!;

    const [numPixelsX, numPixelsY] = [pixels[0] + 1, pixels[1] + 1];

    for (const [name, view] of views) {
      // array for histograms with last histogram being the complete histogram
      let hists: ndarray;
      let noBrush: ndarray;

      // get union of all filter masks that don't contain the dimension(s) for the current view
      const relevantMasks = new Map(filterMasks);
      if (view.type === "0D") {
        // use all filters
      } else if (view.type === "1D") {
        relevantMasks.delete(view.dimension.name);
      } else {
        relevantMasks.delete(view.dimensions[0].name);
        relevantMasks.delete(view.dimensions[1].name);
      }
      const filterMask = union(...relevantMasks.values());

      if (view.type === "0D") {
        hists = ndarray(new CUM_ARR_TYPE(numPixelsX * numPixelsY), [
          numPixelsX,
          numPixelsY
        ]);
        noBrush = ndarray(new HIST_TYPE(1));

        // add data to aggregation matrix
        for (let i = 0; i < this.data.length; i++) {
          // ignore filtered entries
          if (filterMask && filterMask.check(i)) {
            continue;
          }

          const keyActiveX = binActiveX(activeColX.get(i));
          const keyActiveY = binActiveY(activeColY.get(i));
          if (
            0 <= keyActiveX &&
            keyActiveX < numPixelsX &&
            0 <= keyActiveY &&
            keyActiveY < numPixelsY
          ) {
            hists.data[hists.index(keyActiveX, keyActiveY)]++;
          }

          // add to cumulative hist
          noBrush.data[0]++;
        }

        prefixSum(hists);
      } else if (view.type === "1D") {
        const dim = view.dimension;

        const binConfig = dim.binConfig!;
        const bin = binNumberFunction(binConfig);
        const binCount = numBins(binConfig);

        hists = ndarray(new CUM_ARR_TYPE(numPixelsX * numPixelsY * binCount), [
          numPixelsX,
          numPixelsY,
          binCount
        ]);
        noBrush = ndarray(new HIST_TYPE(binCount));

        const column = this.data.getColumn(dim.name)!;

        // add data to aggregation matrix
        for (let i = 0; i < this.data.length; i++) {
          // ignore filtered entries
          if (filterMask && filterMask.check(i)) {
            continue;
          }

          const key = bin(column.get(i));
          const keyActiveX = binActiveX(activeColX.get(i));
          const keyActiveY = binActiveY(activeColY.get(i));
          if (0 <= key && key < binCount) {
            if (
              0 <= keyActiveX &&
              keyActiveX < numPixelsX &&
              0 <= keyActiveY &&
              keyActiveY < numPixelsY
            ) {
              hists.data[hists.index(keyActiveX, keyActiveY, key)]++;
            }

            // add to cumulative hist
            noBrush.data[key]++;
          }
        }

        // compute cumulative sums
        for (let x = 0; x < hists.shape[2]; x++) {
          prefixSum(hists.pick(null, null, x));
        }
      } else {
        throw new Error("2D view brushing and viewing not yet implemented.");
      }

      result.set(name, { hists, noBrush });
    }

    console.timeEnd("Build result cube");

    return result;
  }
}
