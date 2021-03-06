/**
 * Trakt TV V2 API interfacing.
 * Throughout the app the API from Trakt.TV is used to fetch content about shows and optionally the user's data
 *
 * For API docs: check here: http://docs.trakt.apiary.io/#
 */
DuckieTV.factory('TraktTVUpdateService', ['$q', 'TraktTVv2', 'FavoritesService', 'FanartService', '$rootScope','NotificationService',
  function($q, TraktTVv2, FavoritesService, FanartService, $rootScope,NotificationService) {
    var service = {
      /**
       * Update shows in favorites list
       * Fetches all updated shows from trakt.tv since date of passed timestamp, checks if local series were updated
       * before that, and updates those.
       * @param Date from fetch all updates from Trakt.TV since this date (limited to 10.000)
       * @return promise updated items
       */
      getDateString: function(date) {
        if (!date || isNaN(date.getTime())) {
          date = new Date()
        }
        return date.toISOString().split('T')[0]
      },

      update: async function() {
        var updatedCount = 0
        var i = -1
        var totalSeries = FavoritesService.favorites.length
        $rootScope.$broadcast('queryMonitor:update', {
          type: 'start',
          payload: { total: totalSeries, current: 0 }
        })

        for (var serie of FavoritesService.favorites) {
          try {
            i++
            var newSerie = await TraktTVv2.serie(serie.TRAKT_ID, null, true)
            var timeUpdated = new Date(newSerie.updated_at)
            var serieLastUpdated = new Date(serie.lastupdated)

            $rootScope.$broadcast('queryMonitor:update', {
              type: 'progress',
              payload: { total: totalSeries, current: i, name: serie.name }
            })

            if (timeUpdated <= serieLastUpdated) {
              continue // Hasn't been updated
            }

            console.log('[TraktTVUpdateService] [' + i + '/' + totalSeries + ']', 'updating', serie.name)
            newSerie = await TraktTVv2.serie(newSerie.trakt_id, newSerie)
            await FavoritesService.addFavorite(newSerie, undefined, undefined, true)
            updatedCount++
          } catch (err) {
            console.error(err)
            // ignored
          }
        }

        $rootScope.$broadcast('queryMonitor:update', {
          type: 'finish',
          payload: { total: totalSeries, current: i + 1 }
        })

        return updatedCount
      },

      /**
       * Save Trakt.TV's trending list to localstorage once a week
       * Fetches images for any new shows added to the trending list
       * Existing shows with posters use their existing poster urls
       */
      updateCachedTrending: function() {
        var oldCache = localStorage.getItem('trakttv.trending.cache')
        oldCache = oldCache ? JSON.parse(oldCache) : []
        var oldCacheIds = oldCache ? oldCache.map(function(a) {
          return a.trakt_id
        }) : []

        return TraktTVv2.trending(true).then(function(result) {
          return Promise.all(result.map(function(serie) {
            return new Promise(function(resolve) {
              // Delete bunch of stuff we don't need to save space
              delete serie.ids
              delete serie.available_translations
              delete serie.title
              delete serie.tvrage_id
              delete serie.imdb_id
              delete serie.updated_at
              delete serie.aired_episodes
              delete serie.homepage
              delete serie.slug_id
              var originalSerie = oldCache[oldCacheIds.indexOf(serie.trakt_id)]
              if (originalSerie && originalSerie.poster) {
                serie.poster = originalSerie.poster
                return resolve(serie)
              }
              FanartService.get(serie.tvdb_id).then(function(fanart) {
                serie.poster = FanartService.getTrendingPoster(fanart)
                return resolve(serie)
              })
            })
          })).then(function(shows) {
            localStorage.setItem('trakttv.trending.cache', JSON.stringify(shows))
            return true
          })
        })
      },

      updateTraktTvdbXref: async function(traktStart, traktEnd) {
        var out = {}
        var out0 = {}
        for (var trakt = traktStart; trakt < traktEnd; trakt++) {
          try {
            var newSerie = await TraktTVv2.serie2(trakt)
            if (newSerie.tvdb_id != 0 && newSerie.tvdb_id != null) {
              out[newSerie.trakt_id] = newSerie.tvdb_id
            } else {
              out0[newSerie.trakt_id] = 0
            }
            console.debug('found ',newSerie.trakt_id, newSerie.title, newSerie.tvdb_id)
          } catch (err) {
            // ignored
          }
        }
        console.debug('[Trakt->TVDB]', JSON.stringify(out))
        console.debug('[Trakt->TVDB=0]', JSON.stringify(out0))
        NotificationService.notify(
            "Extract Trakt-tvdb done:",
            ["For ", traktStart, " - " , traktEnd - 1, " Torrent"].join(' ')
        )
      },

      trimTraktTvdbXref: async function(XrefTraktids) {
        var traktStart = 0
        var traktEnd = XrefTraktids.length - 1
        for (var trakt = traktStart; trakt < traktEnd; trakt++) {
          var traktid = XrefTraktids[trakt]
          try {
            var newSerie = await TraktTVv2.serie2(traktid)
            if (newSerie.tvdb_id != 0 && newSerie.tvdb_id != null) {
              // note: TraktTVv2.serie2 will supplement tvdbid from existing xref table
              console.debug('[',trakt,'of',traktEnd,']',XrefTraktids[trakt],'has tvdbid',newSerie.tvdb_id)
            } else {
              // this is a genuine missing tvdbid, not in trakt.tv or existing xref table
              console.debug('[',trakt,'of',traktEnd,']',XrefTraktids[trakt],'does not have a tvdbid')
            }
          } catch (err) {
            // ignored
          }
        }
        console.debug('trimTraktTvdbXref finished')
        NotificationService.notify(
            "Extract trimTraktTvdbXref done:",
            ["For ", XrefTraktids[traktStart], " - " , XrefTraktids[traktEnd - 1], " Torrent"].join(' ')
        )
      }

    }

    return service
  }
])

DuckieTV.run(['TraktTVUpdateService', 'SettingsService',
  function(TraktTVUpdateService, SettingsService) {
    var updateFunc = function() {
      var localDateTime = new Date().getTime()
      var tuPeriod = parseInt(SettingsService.get('trakt-update.period')) // TraktTV Update period in hours.
      if (!localStorage.getItem('trakttv.lastupdated')) {
        localStorage.setItem('trakttv.lastupdated', localDateTime)
      }

      var lastUpdated = new Date(parseInt(localStorage.getItem('trakttv.lastupdated')))
      if ((parseInt(localStorage.getItem('trakttv.lastupdated')) + (1000 * 60 * 60 * tuPeriod)) /* hours */ <= localDateTime) {
        TraktTVUpdateService.update(lastUpdated).then(function(count) {
          console.info('TraktTV update check completed. ' + count + ' shows updated since ' + lastUpdated)
          localStorage.setItem('trakttv.lastupdated', localDateTime)
        })
      } else {
        console.info('Not performing TraktTV update check. Already done within the last %s hour(s).', tuPeriod)
      }

      if (!localStorage.getItem('trakttv.lastupdated.trending')) {
        localStorage.setItem('trakttv.lastupdated.trending', 0)
      }

      if ((parseInt(localStorage.getItem('trakttv.lastupdated.trending')) + (1000 * 60 * 60 * 24 * 7)) /* 1 week */ < new Date().getTime()) {
        TraktTVUpdateService.updateCachedTrending().then(function() {
          console.info('TraktTV trending update completed. last updated:' + new Date(parseInt(localStorage.getItem('trakttv.lastupdated.trending'))).toString())
          localStorage.setItem('trakttv.lastupdated.trending', new Date().getTime())
        })
      } else {
        console.info('Not performing TraktTV trending update check. Last done ' + new Date(parseInt(localStorage.getItem('trakttv.lastupdated.trending'))).toString())
      }

      setTimeout(updateFunc, 1000 * 60 * 60 * tuPeriod) // schedule update check every tuPeriod hour(s) for long running apps.
    }

    setTimeout(updateFunc, 7000)

  }
])

/**
 * todo: create generic update service that we can extend  so that it can also fetch xem updates
 * and trakt updates
 */
