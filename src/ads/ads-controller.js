//@flow
import Player from '../player';
import {AdEventType} from './ad-event-type';
import EventManager from '../event/event-manager';
import FakeEventTarget from '../event/fake-event-target';
import FakeEvent from '../event/fake-event';
import {CustomEventType, Html5EventType} from '../event/event-type';
import Error from '../error/error';
import {AdBreak} from './ad-break';
import {Ad} from './ad';
import getLogger from '../utils/logger';

declare type RunTimeAdBreakObject = PKAdBreakObject & {
  played: boolean
};

/**
 * @class AdsController
 * @param {Player} player - The player.
 * @param {IAdsController} adsPluginController - The controller of the current ads plugin instance.
 */
class AdsController extends FakeEventTarget implements IAdsController {
  static _logger: any = getLogger('AdsController');

  _player: Player;
  _adsPluginControllers: Array<IAdsPluginController>;
  _allAdsCompleted: boolean;
  _eventManager: EventManager;
  _adBreaksLayout: Array<number>;
  _adBreak: ?AdBreak;
  _ad: ?Ad;
  _adPlayed: boolean;
  _snapback: number;
  _configAdBreaks: Array<RunTimeAdBreakObject>;
  _adIsLoading: boolean;

  constructor(player: Player, adsPluginControllers: Array<IAdsPluginController>) {
    super();
    this._player = player;
    this._eventManager = new EventManager();
    this._adsPluginControllers = adsPluginControllers;
    this._init();
  }

  /**
   * @instance
   * @memberof AdsController
   * @returns {boolean} - Whether all ads completed.
   */
  get allAdsCompleted(): boolean {
    return this._allAdsCompleted;
  }

  /**
   * @instance
   * @memberof AdsController
   * @returns {boolean} - Whether we're in an ad break.
   */
  isAdBreak(): boolean {
    return !!this._adBreak;
  }

  /**
   * @instance
   * @memberof AdsController
   * @returns {Array<number>} - The ad breaks layout (cue points).
   */
  getAdBreaksLayout(): Array<number> {
    return this._adBreaksLayout;
  }

  /**
   * @instance
   * @memberof AdsController
   * @returns {?AdBreak} - Gets the current ad break data.
   */
  getAdBreak(): ?AdBreak {
    return this._adBreak;
  }

  /**
   * @instance
   * @memberof AdsController
   * @returns {?Ad} - Gets the current ad data.
   */
  getAd(): ?Ad {
    return this._ad;
  }

  /**
   * Skip on an ad.
   * @instance
   * @memberof AdsController
   * @returns {void}
   */
  skipAd(): void {
    const activeController = this._adsPluginControllers.find(controller => controller.active);
    activeController && activeController.skipAd();
  }

  /**
   * Play an ad on demand.
   * @param {PKAdPod} adPod - The ad pod play.
   * @instance
   * @memberof AdsController
   * @returns {void}
   */
  playAdNow(adPod: PKAdPod): void {
    if (this.isAdBreak()) {
      AdsController._logger.warn('Tried to call playAdNow during an ad break');
    } else {
      this._playAdBreak({
        position: this._player.currentTime || 0,
        ads: adPod,
        played: false
      });
    }
  }

  _init(): void {
    this._initMembers();
    this._addBindings();
    this._handleConfiguredAdBreaks();
  }

  _initMembers(): void {
    this._allAdsCompleted = true;
    this._adBreaksLayout = [];
    this._adBreak = null;
    this._ad = null;
    this._adPlayed = false;
    this._snapback = 0;
    this._adIsLoading = false;
  }

  _addBindings(): void {
    this._eventManager.listen(this._player, AdEventType.AD_MANIFEST_LOADED, event => this._onAdManifestLoaded(event));
    this._eventManager.listen(this._player, AdEventType.AD_BREAK_START, event => this._onAdBreakStart(event));
    this._eventManager.listen(this._player, AdEventType.AD_LOADED, event => this._onAdLoaded(event));
    this._eventManager.listen(this._player, AdEventType.AD_STARTED, event => this._onAdStarted(event));
    this._eventManager.listen(this._player, AdEventType.AD_BREAK_END, () => this._onAdBreakEnd());
    this._eventManager.listen(this._player, AdEventType.ADS_COMPLETED, () => this._onAdsCompleted());
    this._eventManager.listen(this._player, AdEventType.AD_ERROR, event => this._onAdError(event));
    this._eventManager.listen(this._player, CustomEventType.PLAYER_RESET, () => this._reset());
    this._eventManager.listenOnce(this._player, Html5EventType.ENDED, () => this._onEnded());
  }

  _handleConfiguredAdBreaks(): void {
    const playAdsAfterTime = this._player.config.advertising.playAdsAfterTime || this._player.config.playback.startTime;
    this._configAdBreaks = this._player.config.advertising.adBreaks
      .filter(adBreak => typeof adBreak.position === 'number' && adBreak.ads.length)
      .map(adBreak => ({
        ...adBreak,
        ads: adBreak.ads.slice(),
        played: -1 < adBreak.position && adBreak.position <= playAdsAfterTime
      }))
      .sort((a, b) => a.position - b.position);
    if (this._configAdBreaks.length) {
      const adBreaksPosition = this._configAdBreaks.map(adBreak => adBreak.position);
      AdsController._logger.debug(AdEventType.AD_MANIFEST_LOADED, adBreaksPosition);
      this._player.dispatchEvent(new FakeEvent(AdEventType.AD_MANIFEST_LOADED, {adBreaksPosition}));
      if (adBreaksPosition.includes(0)) {
        this._handleConfiguredPreroll();
      }
      if (adBreaksPosition.some(position => position > 0)) {
        this._handleConfiguredMidrolls();
      }
    }
  }

  _handleConfiguredPreroll(): void {
    const adBreak = this._configAdBreaks.find(adBreak => adBreak.position === 0 && !adBreak.played);
    if (adBreak) {
      this._playAdBreak(adBreak);
    }
  }

  _handleConfiguredMidrolls(): void {
    this._eventManager.listen(this._player, Html5EventType.TIME_UPDATE, () => {
      if (!this._player.paused) {
        const adBreaks = this._configAdBreaks.filter(
          adBreak => !adBreak.played && this._player.currentTime && adBreak.position <= this._player.currentTime && adBreak.position > this._snapback
        );
        if (adBreaks.length) {
          const lastAdBreak = adBreaks[adBreaks.length - 1];
          this._snapback = lastAdBreak.position;
          AdsController._logger.debug(`Set snapback value ${this._snapback}`);
          this._playAdBreak(lastAdBreak);
        }
      }
    });
    this._eventManager.listen(this._player, Html5EventType.SEEKED, () => {
      const nextPlayedAdBreakIndex = this._configAdBreaks.findIndex(
        adBreak => adBreak.played && typeof this._player.currentTime === 'number' && this._player.currentTime < adBreak.position
      );
      if (nextPlayedAdBreakIndex > 0 && !this._configAdBreaks[nextPlayedAdBreakIndex - 1].played) {
        this._snapback = 0;
        AdsController._logger.debug('Reset snapback value');
      }
    });
  }

  _playAdBreak(adBreak: RunTimeAdBreakObject): void {
    const adController = this._adsPluginControllers.find(controller => !this._isBumper(controller));
    if (adController) {
      adBreak.played = true;
      this._adIsLoading = true;
      AdsController._logger.debug(`Playing ad break positioned in ${adBreak.position}`);
      adController.playAdNow(adBreak.ads);
    } else {
      AdsController._logger.warn('No ads plugin registered');
    }
  }

  _onAdManifestLoaded(event: FakeEvent): void {
    this._adBreaksLayout = Array.from(new Set(this._adBreaksLayout.concat(event.payload.adBreaksPosition))).sort();
    this._allAdsCompleted = false;
  }

  _onAdBreakStart(event: FakeEvent): void {
    this._adBreak = event.payload.adBreak;
  }

  _onAdLoaded(event: FakeEvent): void {
    this._adIsLoading = false;
    this._ad = event.payload.ad;
  }

  _onAdStarted(event: FakeEvent): void {
    this._ad = event.payload.ad;
    this._adPlayed = true;
  }

  _onAdBreakEnd(): void {
    this._adBreak = null;
    this._ad = null;
  }

  _onAdsCompleted(): void {
    if (this._adsPluginControllers.every(controller => controller.done) && this._configAdBreaks.every(adBreak => adBreak.played)) {
      this._allAdsCompleted = true;
      AdsController._logger.debug(AdEventType.ALL_ADS_COMPLETED);
      this.dispatchEvent(new FakeEvent(AdEventType.ALL_ADS_COMPLETED));
    }
  }

  _onAdError(event: FakeEvent): void {
    this._adIsLoading = false;
    if (
      event.payload.severity === Error.Severity.CRITICAL &&
      this._adsPluginControllers.every(controller => controller.done) &&
      this._configAdBreaks.every(adBreak => adBreak.played)
    ) {
      this._allAdsCompleted = true;
      if (this._adPlayed) {
        AdsController._logger.debug(AdEventType.ALL_ADS_COMPLETED);
        this.dispatchEvent(new FakeEvent(AdEventType.ALL_ADS_COMPLETED));
      }
    }
  }

  _isBumper(controller: IAdsPluginController): boolean {
    return controller.name === 'bumper';
  }

  _onEnded(): void {
    if (this._adIsLoading) {
      return;
    }
    if (!this._adBreaksLayout.includes(-1)) {
      this._allAdsCompleted = true;
    } else {
      const bumperCtrl = this._adsPluginControllers.find(controller => this._isBumper(controller));
      const adCtrl = this._adsPluginControllers.find(controller => !this._isBumper(controller));
      const bumperCompletePromise = bumperCtrl ? bumperCtrl.onPlaybackEnded() : Promise.resolve();
      // $FlowFixMe
      bumperCompletePromise.finally(() => {
        adCtrl &&
          // $FlowFixMe
          adCtrl.onPlaybackEnded().finally(() => {
            this._handleConfiguredPostroll();
          });
      });
    }
  }

  _handleConfiguredPostroll(): void {
    const adBreak = this._configAdBreaks.find(adBreak => !adBreak.played && adBreak.position === -1);
    if (adBreak) {
      this._configAdBreaks.forEach(adBreak => (adBreak.played = true));
      this._playAdBreak(adBreak);
    }
  }

  _reset(): void {
    this._eventManager.removeAll();
    this._init();
  }
}

export {AdsController};
