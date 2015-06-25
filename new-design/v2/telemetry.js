(function(exports) {
"use strict";

function assert(condition, message) {
  if (!condition) { throw message || "Assertion failed"; }
  return condition;
}

var Telemetry = {
  //BASE_URL: 'http://ec2-54-185-7-17.us-west-2.compute.amazonaws.com:5000/',
  BASE_URL: 'http://ec2-52-12-57-130.us-west-2.compute.amazonaws.com:5000/',
  CHANNEL_VERSION_DATES: null,
  CACHE: {}, CACHE_LAST_UPDATED: {}, CACHE_TIMEOUT: 4 * 60 * 60 * 1000,
};

var urlCallbacks = {}

Telemetry.Histogram = (function() {
  function Histogram(buckets, values, kind, submissions, description) {
    assert(typeof buckets[0] === "number", "`buckets` must be an array");
    assert(typeof values[0] === "number", "`values` must be an array");
    assert(typeof kind === "string", "`kind` must be a string");
    assert(typeof submissions === "number", "`submissions` must be a number");
    assert(typeof description === "string", "`description` must be a string");
    this.buckets = buckets;
    this.values = values;
    
    this.count = this.values.reduce(function(previous, count) { return previous + count; }, 0);
    this.kind = kind;
    this.submissions = submissions;
    this.description = description;
  }
  
  Histogram.prototype.lastBucketUpper = function() {
    assert(this.kind === "linear" || this.kind === "exponential", "Histogram buckets must be linear or exponential");
    assert(this.buckets.length > 0, "Histogram buckets cannot be empty");
    if (this.buckets.length == 1) return this.buckets[0] + 1;
    if (this.kind === "linear") {
      return this.buckets[this.buckets.length - 1] + this.buckets[this.buckets.length - 1] - this.buckets[this.buckets.length - 2];
    } else { // exponential
      return this.buckets[this.buckets.length - 1] * this.buckets[this.buckets.length - 1] / this.buckets[this.buckets.length - 2];
    }
  };
  
  Histogram.prototype.mean = function() {
    assert(this.kind === "linear" || this.kind === "exponential", "Histogram buckets must be linear or exponential");
    var buckets = this.buckets.concat([this.lastBucketUpper(this.buckets, this.kind)]);
    var totalHits = 0, bucketHits = 0;
    var linearTerm = (buckets[buckets.length - 1] - buckets[buckets.length - 2]) / 2;
    var exponentialFactor = Math.sqrt(buckets[buckets.length - 1] / buckets[buckets.length - 2]);
    var linearBuckets = this.kind === "linear";
    this.values.forEach(function(count, i) {
      totalHits += count;
      var centralX = linearBuckets ? buckets[i] + linearTerm : buckets[i] * exponentialFactor; // find the center of the current bucket
      bucketHits += count * centralX;
    });
    return bucketHits / totalHits;
  }
  
  Histogram.prototype.percentile = function(percentile) {
    assert(this.kind === "linear" || this.kind === "exponential", "histogram buckets must be linear or exponential");
    assert(typeof percentile === "number", "`percentile` must be a number");
    assert(0 <= percentile && percentile <= 100, "`percentile` must be between 0 and 100 inclusive");
    var buckets = this.buckets.concat([this.lastBucketUpper()]);
    var linearTerm = buckets[buckets.length - 1] - buckets[buckets.length - 2];
    var exponentialFactor = buckets[buckets.length - 1] / buckets[buckets.length - 2];
    
    var hitsAtPercentileInBar = this.values.reduce(function(previous, count) { return previous + count; }, 0) * (percentile / 100);
    var percentileBucketIndex = 0;
    while (hitsAtPercentileInBar >= 0) { hitsAtPercentileInBar -= this.values[percentileBucketIndex]; percentileBucketIndex ++; }
    percentileBucketIndex --; hitsAtPercentileInBar += this.values[percentileBucketIndex]; // decrement to get to the bar containing the percentile
    var ratioInBar = hitsAtPercentileInBar / this.values[percentileBucketIndex]; // the ratio of the hits in the percentile to the hits in the bar containing it - how far we are inside the bar
    if (this.kind === "linear") {
      return buckets[percentileBucketIndex] + linearTerm * ratioInBar; // linear interpolation within bar
    } else { // exponential
      return buckets[percentileBucketIndex] * Math.pow(exponentialFactor, ratioInBar); // geometric interpolation within bar
    }
  };
  
  Histogram.prototype.map = function(callback) {
    var buckets = this.buckets.concat([this.lastBucketUpper()]);
    var histogram = this;
    return this.values.map(function(count, i) {
      return callback.call(histogram, count, buckets[i], buckets[i + 1], i);
    });
  }
  
  return Histogram;
})();

Telemetry.Evolution = (function() {
  function Evolution(buckets, data, kind, description) {
    assert(typeof buckets[0] === "number", "`buckets` must be an array");
    assert(typeof data[0].histogram[0] === "number", "`data` must be an array");
    assert(typeof kind === "string", "`kind` must be a string");
    assert(typeof description === "string", "`description` must be a string");
    this.buckets = buckets;
    this.data = data;
    this.kind = kind;
    this.description = description;
  }
  
  Evolution.prototype.dates = function() {
    return this.data.map(function(entry) {
      assert(entry.date.length === 8, "Invalid date string");
      var YYYY = entry.date.substring(0, 4), MM = entry.date.substring(4, 6), DD = entry.date.substring(6, 8);
      return new Date(YYYY + "-" + MM + "-" + DD);
    }).sort(function(a, b) { return a - b; });
  };

  Evolution.prototype.combine = function(otherEvolution) {
    assert(otherEvolution.buckets.length > 0, "`otherEvolution` must be a histograms collection");
    assert(this.kind === otherEvolution.kind, "`this` and `otherEvolution` must be of the same kind");
    assert(this.buckets.length === otherEvolution.buckets.length, "`this` and `otherEvolution` must have the same buckets");
    var dateMap = {};
    this.data.forEach(function(histogramEntry) {
      if (!dateMap.hasOwnProperty(histogramEntry.date)) { dateMap[histogramEntry.date] = []; }
      dateMap[histogramEntry.date].push(histogramEntry);
    });
    otherEvolution.data.forEach(function(histogramEntry) {
      if (!dateMap.hasOwnProperty(histogramEntry.date)) { dateMap[histogramEntry.date] = []; }
      dateMap[histogramEntry.date].push(histogramEntry);
    });
    var dataset = [];
    Object.keys(dateMap).sort().forEach(function(date) {
      var entries = dateMap[date];
      var histogram = entries[0].histogram.map(function(count) { return 0; });
      entries.forEach(function(entry) { // go through each histogram entry and combine histograms
        entry.histogram.forEach(function(count, i) { histogram[i] += count; });
      });
      dataset.push({
        date: date,
        count: entries.reduce(function(previous, entry) { return previous + entry.count }, 0),
        label: entries[0].label,
        histogram: histogram,
      });
    });
    return new Telemetry.Evolution(this.buckets, dataset, this.kind, this.description);
  };
  
  Evolution.prototype.histogram = function(startDate, endDate, cumulative) {
    assert(startDate.getTime, "`startDate` must be a date");
    assert(endDate.getTime, "`endDate` must be a date");
    cumulative = cumulative || false;

    var submissions = 0;
    var values = this.data.reduce(function(values, entry) {
      assert(entry.date.length === 8, "Invalid date string");
      var YYYY = entry.date.substring(0, 4), MM = entry.date.substring(4, 6), DD = entry.date.substring(6, 8);
      var date = new Date(YYYY + "-" + MM + "-" + DD);
      if (startDate <= date && date <= endDate) {
        submissions += entry.count;
        entry.histogram.forEach(function(count, i) { values[i] += count; });
      }
      return values;
    }, this.buckets.map(function(lowerBound) { return 0; }));
    
    if (cumulative) {
      var total = 0;
      values = values.forEach(function(count) { return total += count; });
    }
    return new Telemetry.Histogram(this.buckets, values, this.kind, submissions, this.description);
  };
  
  Evolution.prototype.map = function(callback) {
    var evolution = this;
    return this.data.sort(function(a, b) { return parseInt(a.date) - parseInt(b.date); })
      .map(function(entry, i) {
      var histogram = new Telemetry.Histogram(evolution.buckets, entry.histogram, evolution.kind, entry.count, evolution.description);
      return callback.call(evolution, histogram, i);
    });
  };
  
  Evolution.prototype.means = function() {
    return this.map(function(histogram, i) { return histogram.mean(); });
  };
  
  Evolution.prototype.percentiles = function(percentile) {
    return this.map(function(histogram, i) { return histogram.percentile(percentile); });
  };
  
  Evolution.prototype.submissions = function() {
    return this.map(function(histogram, i) { return histogram.submissions; });
  };
  
  return Evolution;
})();

Telemetry.getJSON = function(url, callback) { // WIP: need CORS headers in the response to do cross-origin requests - currently have cross-origin security disabled
  assert(typeof url === "string", "`url` must be a string");
  assert(typeof callback === "function", "`callback` must be a function");
  if (Telemetry.CACHE[url] !== undefined) {
    if (Telemetry.CACHE[url]._loading) { // Requested but not yet loaded
      var xhr = Telemetry.CACHE[url];
      var originalCallback = xhr.onload;
      xhr.onload = function() {
        callback(JSON.parse(this.responseText), null);
        originalCallback.call(xhr);
      };
    } else if ((new Date).getTime() - Telemetry.CACHE_LAST_UPDATED[url] < Telemetry.CACHE_TIMEOUT) { // In cache and hasn't expired
      setTimeout(function() { callback(Telemetry.CACHE[url]); }, 1);
    }
    return;
  }
  
  var xhr = new XMLHttpRequest();
  xhr._loading = true;
  Telemetry.CACHE[url] = xhr; // Mark the URL as being requested but not yet loaded
  xhr.onload = function() {
    var result = JSON.parse(this.responseText);
    Telemetry.CACHE[url] = result;
    Telemetry.CACHE_LAST_UPDATED[url] = (new Date).getTime();
    callback(result, null);
  };
  xhr.onerror = function() { callback(null, this.status); };
  xhr.open("get", url, true);
  xhr.send();
}

Telemetry.init = function Telemetry_init(callback) {
  assert(typeof callback === "function", "`callback` must be a function");
  //Telemetry.getJSON(Telemetry.BASE_URL + "aggregates_by/build_id/channels/", function(channels) {
    var channels = ["nightly", "aurora", "beta"]; //wip: hardcode the channels as they don't really change
    var loadedChannels = 0;
    Telemetry.CHANNEL_VERSION_DATES = {};
    channels.forEach(function(channel, i) {
      var versionDates = Telemetry.CHANNEL_VERSION_DATES[channel] = {};
      Telemetry.getJSON(Telemetry.BASE_URL + "aggregates_by/build_id/channels/" + channel + "/dates/", function(dateEntries) {
        dateEntries.forEach(function(entry) {
          if (!versionDates.hasOwnProperty(entry.version)) { versionDates[entry.version] = []; }
          versionDates[entry.version].push(entry.date);
        })
        loadedChannels ++; // Loaded another channel's dates
        if (loadedChannels == channels.length) { // This is the last channel that needs to be loaded
          callback();
        }
      });
    });
  //});
},

Telemetry.getHistogramsOverBuilds = function Telemetry_getHistogramsOverBuilds(channel, version, metric, filters, callback) {
  assert(typeof Telemetry.CHANNEL_VERSION_DATES !== null, "Telemetry.js must be initialized before use");
  assert(typeof channel === "string", "`channel` must be a string");
  assert(typeof version === "string", "`version` must be a string");
  assert(typeof metric === "string", "`metric` must be a string");
  assert(typeof filters === "object", "`filters` must be an object");
  assert(typeof callback === "function", "`callback` must be a function");
  var buildDates = Telemetry.CHANNEL_VERSION_DATES[channel][version].join(",");
  var filterString = "";
  Object.keys(filters).sort().forEach(function(filterName) { // we need to sort the keys in order to make sure the same filters result in the same URL each time, for caching
    filterString += "&" + encodeURIComponent(filterName) + "=" + encodeURIComponent(filters[filterName]);
  });
  Telemetry.getJSON(Telemetry.BASE_URL + "aggregates_by/build_id/channels/" + channel +
    "/?version=" + encodeURIComponent(version) + "&dates=" + encodeURIComponent(buildDates) +
    "&metric=" + encodeURIComponent(metric) + filterString, function(histograms) {
    var evolution = new Telemetry.Evolution(histograms.buckets, histograms.data, histograms.kind, histograms.description);
    callback(evolution);
  });
}

Telemetry.getFilterOptions = function Telemetry_getOptions(channel, version, callback) {
  assert(typeof channel === "string", "`channel` must be a string");
  assert(typeof version === "string", "`version` must be a string");
  assert(typeof callback === "function", "`callback` must be a function");
  Telemetry.getJSON(Telemetry.BASE_URL + "aggregates_by/build_id/channels/" + channel + "/filters", function(filterOptions) {
    callback(filterOptions);
  });
}

Telemetry.getVersions = function Telemetry_getVersions() { // shim function
  assert(typeof Telemetry.CHANNEL_VERSION_DATES !== null, "Telemetry.js must be initialized before use");
  var versions = [];
  for (var channel in Telemetry.CHANNEL_VERSION_DATES) {
    Object.keys(Telemetry.CHANNEL_VERSION_DATES[channel]).forEach(function(version) {
      versions.push(channel + "/" + version);
    });
  }
  return versions.sort();
}

Telemetry.getMeasures = function Telemetry_getMeasures(channel, version, callback) {
  assert(typeof channel === "string", "`channel` must be a string");
  assert(typeof version === "string", "`version` must be a string");
  assert(typeof callback === "function", "`callback` must be a function");
  Telemetry.getJSON(Telemetry.BASE_URL + "aggregates_by/build_id/channels/" + channel +
    "/filters/metric", function(metrics) {
    callback(metrics);
  });
}

exports.Telemetry = Telemetry;
return Telemetry;
})(this);
