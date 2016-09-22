(function() {
  'use strict';

  function defaults(obj) {
    if (typeof obj !== 'object') {
      return obj;
    }
    for (var i = 1, length = arguments.length; i < length; i++) {
      var source = arguments[i];
      for (var prop in source) {
        if (obj[prop] === void 0) {
          obj[prop] = source[prop];
        }
      }
    }
    return obj;
  }

  angular.module('apMesa.directives.apMesa', [
    'apMesa.controllers.ApMesaController',
    'apMesa.directives.apMesaRows',
    'apMesa.directives.apMesaDummyRows',
    'apMesa.directives.apMesaExpandable'
  ])
  .provider('apMesa', function ApMesaService() {
    var defaultOptions = {
      bgSizeMultiplier: 1,
      rowPadding: 300,
      bodyHeight: 300,
      fixedHeight: false,
      defaultRowHeight: 40,
      scrollDebounce: 100,
      scrollDivisor: 1,
      loadingText: 'loading',
      loadingError: false,
      noRowsText: 'no rows',
      sortClasses: [
        'glyphicon glyphicon-sort',
        'glyphicon glyphicon-chevron-up',
        'glyphicon glyphicon-chevron-down'
      ],
      onRegisterApi: function(api) {
        // noop - user overrides to get a hold of api object
      }
    };
    this.setDefaultOptions = function(overrides) {
      defaultOptions = defaults(overrides, defaultOptions);
    }
    this.$get = [function(){
      return {
        getDefaultOptions: function() {
          return defaultOptions;
        }
      }
    }];
  })
  .directive('apMesa', ['$log', '$timeout', '$q', 'apMesa', function ($log, $timeout, $q, apMesa) {

    function debounce(func, wait, immediate) {
      var timeout, args, context, timestamp, result;

      var later = function() {
        var last = Date.now() - timestamp;

        if (last < wait && last > 0) {
          timeout = $timeout(later, wait - last);
        } else {
          timeout = null;
          if (!immediate) {
            result = func.apply(context, args);
            if (!timeout) {
              context = args = null;
            }
          }
        }
      };

      return function() {
        context = this;
        args = arguments;
        timestamp = Date.now();
        var callNow = immediate && !timeout;
        if (!timeout) {
          timeout = $timeout(later, wait);
        }
        if (callNow) {
          result = func.apply(context, args);
          context = args = null;
        }

        return result;
      };
    }

    function resetState(scope) {
      // State of expanded rows
      scope.expandedRows = {};
      scope.expandedRowHeights = {};

      // Object that holds search terms
      scope.searchTerms = {};

      // Array and Object for sort order+direction
      scope.sortOrder = [];
      scope.sortDirection = {};

      // Holds filtered rows count
      scope.filterState = {
        filterCount: scope.rows ? scope.rows.length : 0
      };

      // Offset and limit
      scope.rowOffset = 0;

      scope.$broadcast('apMesa:stateReset');
    }

    function initOptions(scope) {

      // Sanity check for getter
      if (scope.options !== undefined && scope.options.hasOwnProperty('getter')) {
        if (typeof scope.options.getter !== 'function') {
          throw new Error('"getter" in "options" should be a function!');
        }
      }

      // Default Options, extend provided ones
      scope.options = scope.options || {};
      var trackByOverride = scope.trackBy ? { trackBy: scope.trackBy } : {};
      defaults(scope.options, trackByOverride, apMesa.getDefaultOptions());
      initSorts(scope);
    }

    function initSorts(scope) {
      // Look for initial sort order
      if (scope.options.initialSorts) {
        angular.forEach(scope.options.initialSorts, function(sort) {
          scope.addSort(sort.id, sort.dir);
        });
      }
    }

    function resetColumns(scope) {
      if (scope._columns && scope._columns.length) {
        scope.columns = angular.copy(scope._columns);
        scope.setColumns(scope.columns);
        resetState(scope);
      }
    }

    function link(scope, element) {

      var deregStorageWatchers = [];
      resetColumns(scope);
      scope.$watch('_columns', function(columns, oldColumns) {
        if (columns !== scope.columns) {
          resetColumns(scope);
          initSorts(scope);
        }
      });

      resetState(scope);
      initOptions(scope);
      scope.$watch('options', function(newOptions, oldOptions) {
        resetState(scope);
        initOptions(scope);
      });

      scope.$watch('options.storage', function(storage) {
        if (storage) {
          if (!scope.options.storageKey) {
            throw new Error('apMesa: the storage option requires the storageKey option as well. See the README.');
          }
          // Set the storage object on the scope
          scope.storage = scope.options.storage;
          scope.storageKey = scope.options.storageKey;

          // Try loading from storage
          scope.loadFromStorage();

          // Watch various things to save state
          //  Save state on the following action:
          //  - sort change
          //  occurs in $scope.toggleSort
          //  - column order change
          deregStorageWatchers.push(scope.$watchCollection('columns', scope.saveToStorage));
          //  - search terms change
          deregStorageWatchers.push(scope.$watchCollection('searchTerms', scope.saveToStorage));
          //  - paging scheme
          deregStorageWatchers.push(scope.$watch('options.pagingScheme', scope.saveToStorage));
        } else if (deregStorageWatchers.length) {
          deregStorageWatchers.forEach(function(d) { d(); });
          deregStorageWatchers = [];
        }
      });

      var fillHeightWatcher;
      scope.$watch('options.fillHeight', function(fillHeight) {
        if (fillHeight) {
          // calculate available space
          fillHeightWatcher = scope.$on('apMesa:resize', function() {
            scope.options.bodyHeight = element.parent().height() - element.find('.mesa-header-table').outerHeight(true);
          });
          scope.$emit('apMesa:resize');
        } else if (fillHeightWatcher) {
          fillHeightWatcher();
        }
      });

      //  - row limit
      scope.$watch('options.bodyHeight', function() {
        scope.calculateRowLimit();
        scope.tbodyNgStyle = {};
        scope.tbodyNgStyle[ scope.options.fixedHeight ? 'height' : 'max-height' ] = scope.options.bodyHeight + 'px';
        scope.saveToStorage();
      });
      scope.$watch('filterState.filterCount', function() {
        scope.onScroll();
      });
      scope.$watch('rowHeight', function(size) {
        element.find('tr.ap-mesa-dummy-row').css('background-size','auto ' + size * scope.options.bgSizeMultiplier + 'px');
      });
      scope.$watch('options.loadingPromise', function(promise) {
        if (angular.isObject(promise) && typeof promise.then === 'function') {
          scope.api.setLoading(true);
          promise.then(function () {
            scope.options.loadingError = false;
            scope.api.setLoading(false);
          }, function (reason) {
            scope.options.loadingError = true;
            scope.api.setLoading(false);
            $log.warn('Failed loading table data: ' + reason);
          });
        }
      });

      var scrollDeferred;
      var debouncedScrollHandler = debounce(function() {

        scope.calculateRowLimit();

        var scrollTop = scope.scrollDiv[0].scrollTop - scope.options.rowPadding;

        var rowHeight = scope.rowHeight;

        if (rowHeight === 0) {
          return false;
        }

        var rowOffset = 0;
        var runningTotalScroll = 0;
        var expandedOffsets = Object.keys(scope.expandedRows)
          .map(function(i) { return parseInt(i); })
          .sort();

        // push the max offset so this works in constant time
        // when no expanded rows are present
        expandedOffsets.push(scope.filterState.filterCount);

        // a counter that holds the last offset of an expanded row
        for (var i = 0; i <= expandedOffsets.length; i++) {
          // the offset of the expanded row
          var expandedOffset = expandedOffsets[i];

          // the height of the collapsed rows before this expanded row
          // and after the previous expanded row
          var rowsHeight = (expandedOffset - rowOffset) * rowHeight;

          // check if the previous rows is more than enough
          if (runningTotalScroll + rowsHeight >= scrollTop) {
            rowOffset += Math.floor((scrollTop - runningTotalScroll)/rowHeight);
            break;
          }
          // otherwise add it to the running total
          runningTotalScroll += rowsHeight;

          // the pixels that this row's expanded panel displaces
          var expandedPixels = scope.expandedRowHeights[expandedOffset];
          runningTotalScroll += expandedPixels;
          rowOffset = expandedOffset;

          // Check if the expanded panel put us over the edge
          if (runningTotalScroll >= scrollTop) {
            rowOffset--;
            break;
          }
        }

        scope.rowOffset = Math.max(0, rowOffset);

        scrollDeferred.resolve();

        scrollDeferred = null;

        scope.options.scrollingPromise = null;

        scope.$digest();

      }, scope.options.scrollDebounce);

      scope.onScroll = function() {
        if (!scrollDeferred) {
          scrollDeferred = $q.defer();
          scope.options.scrollingPromise = scrollDeferred.promise;
        }
        debouncedScrollHandler();
      };

      scope.scrollDiv = element.find('.mesa-rows-table-wrapper');
      scope.scrollDiv.on('scroll', scope.onScroll);

      // Wait for a render
      $timeout(function() {
        // Calculates rowHeight and rowLimit
        scope.calculateRowLimit();

      }, 0);


      scope.api = {
        isSelectedAll: scope.isSelectedAll,
        selectAll: scope.selectAll,
        deselectAll: scope.deselectAll,
        toggleSelectAll: scope.toggleSelectAll,
        setLoading: function(isLoading, triggerDigest) {
          scope.options.loading = isLoading;
          if (triggerDigest) {
            scope.$digest();
          }
        }

      };

      // Register API
      scope.options.onRegisterApi(scope.api);

    }

    return {
      templateUrl: 'src/templates/apMesa.tpl.html',
      restrict: 'EA',
      replace: true,
      scope: {
        _columns: '=columns',
        rows: '=',
        classes: '@tableClass',
        selected: '=',
        options: '=?',
        trackBy: '@?'
      },
      controller: 'ApMesaController',
      compile: function(tElement) {
        var trackBy = tElement.attr('track-by');
        if (trackBy) {
          tElement.find('.ap-mesa-rendered-rows').attr('track-by', trackBy);
        }
        return link;
      }
    };
  }]);

})();
