/**
 * Address Research Skill
 *
 * Takes a property address and queries public APIs to gather environmental,
 * property, and regulatory data — producing a structured research report
 * that feeds into Phase I ESA narrative writing.
 */

import { BaseSkill } from './base.js';
import { fetchWithRetry, fetchBuffer, queryAllSources } from '../core/api-clients.js';
import type { AppConfig } from '../types/index.js';

// ── Input / Output Types ──────────────────────────────────────────────

export interface AddressResearchInput {
  address: string;
  reportType?: string;
}

export interface GeocodedAddress {
  lat: number;
  lng: number;
  formattedAddress: string;
  city: string;
  county: string;
  state: string;
  zip: string;
}

export interface SanbornMapResult {
  title: string;
  date: string;
  sheetCount: number;
  locUrl: string;
  imageBase64?: string;
}

export interface HistoricalTopoResult {
  title: string;
  date: string;
  scale: string;
  downloadUrl: string;
  thumbnailBase64?: string;
}

export interface EJScreenResult {
  totalPopulation: string;
  percentMinority: string;
  percentLowIncome: string;
  superfundProximity: string;
  rmpProximity: string;
  hazWasteProximity: string;
  waterDischargeProximity: string;
  airToxicsCancer: string;
  dieselPM: string;
  leadPaint: string;
  rawData?: any;
}

export interface StreetViewImage {
  heading: number;
  direction: string;
  base64: string;
}

export interface GroundwaterResult {
  siteCount: number;
  sites: { siteName: string; siteNumber: string; wellDepth: string; waterLevel: string }[];
}

export interface EPAFinding {
  facilityName: string;
  address: string;
  database: string;   // 'RCRA', 'CERCLIS', 'TRI', 'FRS'
  distance: string;
  status: string;
  registryId: string;
}

export interface StateFinding {
  siteName: string;
  address: string;
  database: string;   // 'EnviroStor', 'GeoTracker'
  status: string;
  caseNumber: string;
  distance: string;
}

export interface DataSourceResult {
  name: string;
  url: string;
  status: 'success' | 'partial' | 'failed';
  error?: string;
}

export interface AddressResearchOutput {
  geocode: GeocodedAddress;
  satelliteImageBase64?: string;
  locationMapBase64?: string;
  vicinityMapBase64?: string;
  streetViewImages: StreetViewImage[];
  regulatoryFindings: {
    epa: EPAFinding[];
    state: StateFinding[];
  };
  floodZone: {
    zone: string;
    panelNumber: string;
    inFloodplain: boolean;
  } | null;
  soilData: {
    soilTypes: string[];
    drainageClass: string;
    hydrologicGroup: string;
  } | null;
  sanbornMaps: SanbornMapResult[];
  historicalTopos: HistoricalTopoResult[];
  groundwater: GroundwaterResult | null;
  ejscreen: EJScreenResult | null;
  dataSources: DataSourceResult[];
}

// ── Skill Implementation ──────────────────────────────────────────────

export class AddressResearchSkill extends BaseSkill<AddressResearchInput, AddressResearchOutput> {
  get name(): string {
    return 'AddressResearcher';
  }

  get usesAI(): boolean {
    return false;
  }

  constructor(config: AppConfig) {
    super(config);
  }

  protected async execute(input: AddressResearchInput): Promise<AddressResearchOutput> {
    const { address } = input;
    const dataSources: DataSourceResult[] = [];

    // 1. Geocode the address
    const geocode = await this.geocodeAddress(address, dataSources);

    // 2. Run all queries in parallel with fault tolerance
    const radiusMiles = this.config.research?.epa_search_radius_miles ?? 1;
    const isCaliforniaProperty =
      this.config.research?.enable_california_databases !== false &&
      (geocode.state === 'California' || geocode.state === 'CA');

    const [
      epaResult, enviroStorResult, geoTrackerResult, floodResult, soilResult,
      satelliteResult, locationMapResult, vicinityMapResult, streetViewResult,
      sanbornResult, topoResult, gwResult, ejscreenResult,
    ] = await Promise.allSettled([
        this.queryEPA(geocode.lat, geocode.lng, radiusMiles, dataSources),
        isCaliforniaProperty
          ? this.queryEnviroStor(geocode.lat, geocode.lng, dataSources)
          : Promise.resolve([] as StateFinding[]),
        isCaliforniaProperty
          ? this.queryGeoTracker(geocode.lat, geocode.lng, dataSources)
          : Promise.resolve([] as StateFinding[]),
        this.queryFEMAFloodZone(geocode.lat, geocode.lng, dataSources),
        this.querySoilData(geocode.lat, geocode.lng, dataSources),
        this.fetchSatelliteImage(geocode.lat, geocode.lng, dataSources),
        this.fetchLocationMap(geocode.lat, geocode.lng, dataSources),
        this.fetchVicinityMap(geocode.lat, geocode.lng, dataSources),
        this.fetchStreetViewImages(geocode.lat, geocode.lng, dataSources),
        this.querySanbornMaps(geocode.city, geocode.state, dataSources),
        this.queryHistoricalTopos(geocode.lat, geocode.lng, dataSources),
        this.queryGroundwater(geocode.lat, geocode.lng, dataSources),
        this.queryEJScreen(geocode.lat, geocode.lng, dataSources),
      ]);

    // 3. Aggregate results
    const epaFindings = epaResult.status === 'fulfilled' ? epaResult.value : [];
    const enviroStorFindings = enviroStorResult.status === 'fulfilled' ? enviroStorResult.value : [];
    const geoTrackerFindings = geoTrackerResult.status === 'fulfilled' ? geoTrackerResult.value : [];
    const floodZone = floodResult.status === 'fulfilled' ? floodResult.value : null;
    const soilData = soilResult.status === 'fulfilled' ? soilResult.value : null;
    const satelliteImageBase64 = satelliteResult.status === 'fulfilled' ? satelliteResult.value : undefined;
    const locationMapBase64 = locationMapResult.status === 'fulfilled' ? locationMapResult.value : undefined;
    const vicinityMapBase64 = vicinityMapResult.status === 'fulfilled' ? vicinityMapResult.value : undefined;
    const streetViewImages = streetViewResult.status === 'fulfilled' ? streetViewResult.value : [];
    const sanbornMaps = sanbornResult.status === 'fulfilled' ? sanbornResult.value : [];
    const historicalTopos = topoResult.status === 'fulfilled' ? topoResult.value : [];
    const groundwater = gwResult.status === 'fulfilled' ? gwResult.value : null;
    const ejscreen = ejscreenResult.status === 'fulfilled' ? ejscreenResult.value : null;

    return {
      geocode,
      satelliteImageBase64: satelliteImageBase64 ?? undefined,
      locationMapBase64: locationMapBase64 ?? undefined,
      vicinityMapBase64: vicinityMapBase64 ?? undefined,
      streetViewImages,
      regulatoryFindings: {
        epa: epaFindings,
        state: [...enviroStorFindings, ...geoTrackerFindings],
      },
      floodZone,
      soilData,
      sanbornMaps,
      historicalTopos,
      groundwater,
      ejscreen,
      dataSources,
    };
  }

  // ── Geocoding ─────────────────────────────────────────────────────

  private async geocodeAddress(address: string, dataSources: DataSourceResult[]): Promise<GeocodedAddress> {
    const provider = this.config.research?.geocoding_provider ?? 'nominatim';
    const googleKeyEnv = this.config.research?.google_maps_api_key_env ?? 'GOOGLE_MAPS_API_KEY';
    const googleKey = process.env[googleKeyEnv];

    if (provider === 'google' && googleKey) {
      return this.geocodeWithGoogle(address, googleKey, dataSources);
    }
    return this.geocodeWithNominatim(address, dataSources);
  }

  private async geocodeWithNominatim(address: string, dataSources: DataSourceResult[]): Promise<GeocodedAddress> {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&addressdetails=1&limit=1`;

    const data = await fetchWithRetry<any[]>(url, {
      rateLimitMs: 1100,
      retries: 2,
      headers: { 'User-Agent': 'ODIC-ESA-Pipeline/1.0 (Environmental Research)' },
    });

    dataSources.push({
      name: 'OpenStreetMap Nominatim',
      url,
      status: data && data.length > 0 ? 'success' : 'failed',
      error: !data || data.length === 0 ? 'No geocoding results returned' : undefined,
    });

    if (!data || data.length === 0) {
      throw new Error(`Geocoding failed for address: ${address}`);
    }

    const result = data[0];
    const addr = result.address || {};

    return {
      lat: parseFloat(result.lat),
      lng: parseFloat(result.lon),
      formattedAddress: result.display_name || address,
      city: addr.city || addr.town || addr.village || '',
      county: addr.county || addr.city || '',
      state: addr.state || '',
      zip: addr.postcode || '',
    };
  }

  private async geocodeWithGoogle(address: string, apiKey: string, dataSources: DataSourceResult[]): Promise<GeocodedAddress> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;

    const data = await fetchWithRetry<any>(url, { retries: 2 });

    const ok = data?.status === 'OK' && data.results?.length > 0;
    dataSources.push({
      name: 'Google Geocoding API',
      url: url.replace(apiKey, '***'),
      status: ok ? 'success' : 'failed',
      error: !ok ? `Google geocoding: ${data?.status || 'no response'}` : undefined,
    });

    if (!ok) {
      throw new Error(`Google geocoding failed for address: ${address}`);
    }

    const result = data.results[0];
    const loc = result.geometry.location;
    const components = result.address_components || [];
    const find = (type: string) =>
      components.find((c: any) => c.types?.includes(type))?.long_name || '';

    return {
      lat: loc.lat,
      lng: loc.lng,
      formattedAddress: result.formatted_address || address,
      city: find('locality') || find('sublocality'),
      county: find('administrative_area_level_2'),
      state: find('administrative_area_level_1'),
      zip: find('postal_code'),
    };
  }

  // ── EPA Queries ───────────────────────────────────────────────────

  private async queryEPA(lat: number, lng: number, radiusMiles: number, dataSources: DataSourceResult[]): Promise<EPAFinding[]> {
    const findings: EPAFinding[] = [];

    // Try FRS (Facility Registry Service) first — more reliable endpoint
    const frsUrl = `https://ofmpub.epa.gov/frs_public2/frs_rest_services.search_facilities?latitude83=${lat}&longitude83=${lng}&search_radius=${radiusMiles}&output=JSON`;

    try {
      const frsData = await fetchWithRetry<any>(frsUrl, { retries: 2, timeout: 20000 });

      if (frsData?.Results?.FRSFacility) {
        const facilities = Array.isArray(frsData.Results.FRSFacility)
          ? frsData.Results.FRSFacility
          : [frsData.Results.FRSFacility];

        for (const f of facilities) {
          const programs = f.EnvironmentalInterestInfo || [];
          const programList = Array.isArray(programs) ? programs : [programs];
          const dbNames = programList
            .map((p: any) => p?.PGM_SYS_ACRNM || '')
            .filter(Boolean)
            .join(', ');

          findings.push({
            facilityName: f.PrimaryName || 'Unknown',
            address: [f.LocationAddress, f.CityName, f.StateAbbr].filter(Boolean).join(', '),
            database: dbNames || 'FRS',
            distance: f.DistanceToPoint ? `${parseFloat(f.DistanceToPoint).toFixed(2)} mi` : 'N/A',
            status: f.ActiveIndicator === 'Y' ? 'Active' : 'Inactive',
            registryId: f.RegistryId || '',
          });
        }

        dataSources.push({
          name: 'EPA FRS',
          url: frsUrl,
          status: 'success',
        });
        return findings;
      }
    } catch (err) {
      this.logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'EPA FRS query failed, trying Envirofacts');
    }

    // Fallback: try Envirofacts RCRA endpoint
    const rcraUrl = `https://data.epa.gov/efservice/RCRAINFO/LATITUDE/${lat}/LONGITUDE/${lng}/RADIUS/${radiusMiles}/JSON`;
    try {
      const rcraData = await fetchWithRetry<any[]>(rcraUrl, { retries: 2, timeout: 20000 });

      if (rcraData && Array.isArray(rcraData)) {
        for (const f of rcraData) {
          findings.push({
            facilityName: f.HANDLER_NAME || f.facility_name || 'Unknown',
            address: f.STREET_ADDRESS || f.address || '',
            database: 'RCRA',
            distance: 'N/A',
            status: f.ACTIVITY_LOCATION || f.status || 'Unknown',
            registryId: f.EPA_ID || f.handler_id || '',
          });
        }
      }

      dataSources.push({
        name: 'EPA Envirofacts (RCRA)',
        url: rcraUrl,
        status: rcraData && rcraData.length > 0 ? 'success' : 'partial',
        error: !rcraData || rcraData.length === 0 ? 'No RCRA facilities found' : undefined,
      });
    } catch (err) {
      dataSources.push({
        name: 'EPA Envirofacts (RCRA)',
        url: rcraUrl,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return findings;
  }

  // ── California State Databases ────────────────────────────────────

  private async queryEnviroStor(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<StateFinding[]> {
    const url = `https://www.envirostor.dtsc.ca.gov/public/api`;
    const findings: StateFinding[] = [];

    try {
      // EnviroStor does not have a well-documented public REST API.
      // Attempt a query; if it fails, record as partial for manual review.
      const data = await fetchWithRetry<any>(
        `https://www.envirostor.dtsc.ca.gov/public/api?CMD=search&lat=${lat}&lng=${lng}&radius=1`,
        { retries: 1, timeout: 15000 }
      );

      if (data && Array.isArray(data)) {
        for (const site of data) {
          findings.push({
            siteName: site.SITE_NAME || site.name || 'Unknown',
            address: site.ADDRESS || site.address || '',
            database: 'EnviroStor',
            status: site.STATUS || site.status || 'Unknown',
            caseNumber: site.CLEANUP_SITE_ID || site.id || '',
            distance: 'N/A',
          });
        }
      }

      dataSources.push({
        name: 'DTSC EnviroStor',
        url,
        status: findings.length > 0 ? 'success' : 'partial',
        error: findings.length === 0
          ? 'EnviroStor API returned no results or is not publicly accessible. Check manually at https://www.envirostor.dtsc.ca.gov/public/'
          : undefined,
      });
    } catch (err) {
      dataSources.push({
        name: 'DTSC EnviroStor',
        url,
        status: 'partial',
        error: `EnviroStor API not accessible. Check manually at https://www.envirostor.dtsc.ca.gov/public/ — ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return findings;
  }

  private async queryGeoTracker(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<StateFinding[]> {
    const url = `https://geotracker.waterboards.ca.gov/`;
    const findings: StateFinding[] = [];

    try {
      const data = await fetchWithRetry<any>(
        `https://geotracker.waterboards.ca.gov/data_download_by_county?CMD=search&lat=${lat}&lng=${lng}&radius=1`,
        { retries: 1, timeout: 15000 }
      );

      if (data && Array.isArray(data)) {
        for (const site of data) {
          findings.push({
            siteName: site.SITE_NAME || site.name || 'Unknown',
            address: site.ADDRESS || site.address || '',
            database: 'GeoTracker',
            status: site.STATUS || site.status || 'Unknown',
            caseNumber: site.GLOBAL_ID || site.id || '',
            distance: 'N/A',
          });
        }
      }

      dataSources.push({
        name: 'GeoTracker',
        url,
        status: findings.length > 0 ? 'success' : 'partial',
        error: findings.length === 0
          ? 'GeoTracker API returned no results or is not publicly accessible. Check manually at https://geotracker.waterboards.ca.gov/'
          : undefined,
      });
    } catch (err) {
      dataSources.push({
        name: 'GeoTracker',
        url,
        status: 'partial',
        error: `GeoTracker API not accessible. Check manually at https://geotracker.waterboards.ca.gov/ — ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return findings;
  }

  // ── FEMA Flood Zone ───────────────────────────────────────────────

  private async queryFEMAFloodZone(
    lat: number,
    lng: number,
    dataSources: DataSourceResult[]
  ): Promise<{ zone: string; panelNumber: string; inFloodplain: boolean } | null> {
    const url = `https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL/MapServer/28/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&outFields=FLD_ZONE,DFIRM_ID,PANEL&returnGeometry=false&f=json`;

    try {
      const data = await fetchWithRetry<any>(url, { retries: 2, timeout: 20000 });

      if (data?.features && data.features.length > 0) {
        const attrs = data.features[0].attributes;
        const zone = attrs.FLD_ZONE || 'Unknown';
        const panelNumber = `${attrs.DFIRM_ID || ''}${attrs.PANEL || ''}`;

        // Zones starting with A or V are in the floodplain
        const inFloodplain = /^[AV]/i.test(zone);

        dataSources.push({
          name: 'FEMA NFHL',
          url,
          status: 'success',
        });

        return { zone, panelNumber, inFloodplain };
      }

      dataSources.push({
        name: 'FEMA NFHL',
        url,
        status: 'partial',
        error: 'No flood zone data returned for this location',
      });
      return null;
    } catch (err) {
      dataSources.push({
        name: 'FEMA NFHL',
        url,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── NRCS Soil Data ────────────────────────────────────────────────

  private async querySoilData(
    lat: number,
    lng: number,
    dataSources: DataSourceResult[]
  ): Promise<{ soilTypes: string[]; drainageClass: string; hydrologicGroup: string } | null> {
    const url = 'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest';
    const sql = `SELECT musym, muname, drclassdcd, hydgrpdcd FROM mapunit mu INNER JOIN component c ON mu.mukey = c.mukey WHERE mu.mukey IN (SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(${lng} ${lat})'))`;

    try {
      const data = await fetchWithRetry<any>(url, {
        method: 'POST',
        body: JSON.stringify({ query: sql, format: 'JSON' }),
        headers: { 'Content-Type': 'application/json' },
        retries: 2,
        timeout: 20000,
      });

      if (data?.Table) {
        const rows = data.Table;
        const soilTypes = Array.from(new Set<string>(rows.map((r: any) => r[1] || r.muname).filter(Boolean)));
        const drainageClass = rows[0]?.[2] || rows[0]?.drclassdcd || 'Unknown';
        const hydrologicGroup = rows[0]?.[3] || rows[0]?.hydgrpdcd || 'Unknown';

        dataSources.push({
          name: 'NRCS Web Soil Survey',
          url,
          status: 'success',
        });

        return { soilTypes, drainageClass, hydrologicGroup };
      }

      dataSources.push({
        name: 'NRCS Web Soil Survey',
        url,
        status: 'partial',
        error: 'No soil data returned for this location',
      });
      return null;
    } catch (err) {
      dataSources.push({
        name: 'NRCS Web Soil Survey',
        url,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Library of Congress Sanborn Maps ─────────────────────────────

  private async querySanbornMaps(city: string, state: string, dataSources: DataSourceResult[]): Promise<SanbornMapResult[]> {
    if (!city || !state) {
      dataSources.push({ name: 'Library of Congress (Sanborn)', url: '', status: 'failed', error: 'City/state not available for Sanborn lookup' });
      return [];
    }

    const stateClean = state.length > 2 ? state.toLowerCase() : state.toLowerCase();
    const cityClean = city.toLowerCase().replace(/\s+/g, '+');
    const url = `https://www.loc.gov/collections/sanborn-maps/?fo=json&fa=location:${encodeURIComponent(state)}+${encodeURIComponent(city)}&c=10`;

    try {
      const data = await fetchWithRetry<any>(url, {
        retries: 1, timeout: 15000,
        headers: { 'User-Agent': 'ODIC-ESA-Pipeline/1.0 (Environmental Research)' },
      });

      const results: SanbornMapResult[] = [];

      if (data?.results) {
        for (const item of data.results.slice(0, 5)) {
          const mapResult: SanbornMapResult = {
            title: item.title || item.description?.[0] || 'Sanborn Map',
            date: item.date || item.dates?.[0] || 'Unknown',
            sheetCount: item.shelf_id ? 1 : (item.resources?.length || 1),
            locUrl: item.url || item.id || '',
          };

          // Try to download thumbnail image
          const imageUrl = item.image_url?.[0] || item.image?.thumbnail;
          if (imageUrl) {
            try {
              const imgBuf = await fetchBuffer(imageUrl, { timeout: 10000 });
              if (imgBuf) mapResult.imageBase64 = imgBuf.toString('base64');
            } catch {}
          }

          results.push(mapResult);
        }
      }

      dataSources.push({
        name: 'Library of Congress (Sanborn)',
        url,
        status: results.length > 0 ? 'success' : 'partial',
        error: results.length === 0 ? `No Sanborn maps found for ${city}, ${state}` : undefined,
      });

      return results;
    } catch (err) {
      dataSources.push({
        name: 'Library of Congress (Sanborn)',
        url,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── USGS Historical Topographic Maps ───────────────────────────

  private async queryHistoricalTopos(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<HistoricalTopoResult[]> {
    const delta = 0.05; // ~3.5 mile bounding box
    const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`;
    const url = `https://tnmaccess.nationalmap.gov/api/v1/products?datasets=Historical+Topographic+Maps&bbox=${bbox}&max=10`;

    try {
      const data = await fetchWithRetry<any>(url, { retries: 2, timeout: 20000 });
      const results: HistoricalTopoResult[] = [];

      if (data?.items) {
        for (const item of data.items.slice(0, 5)) {
          const topoResult: HistoricalTopoResult = {
            title: item.title || 'Historical Topo Map',
            date: item.publicationDate || item.dateCreated || 'Unknown',
            scale: item.mapScale || 'Unknown',
            downloadUrl: item.downloadURL || item.previewGraphicURL || '',
          };

          // Try to download preview thumbnail
          const previewUrl = item.previewGraphicURL;
          if (previewUrl) {
            try {
              const imgBuf = await fetchBuffer(previewUrl, { timeout: 10000 });
              if (imgBuf) topoResult.thumbnailBase64 = imgBuf.toString('base64');
            } catch {}
          }

          results.push(topoResult);
        }
      }

      dataSources.push({
        name: 'USGS Historical Topos',
        url,
        status: results.length > 0 ? 'success' : 'partial',
        error: results.length === 0 ? 'No historical topo maps found for this location' : undefined,
      });

      return results;
    } catch (err) {
      dataSources.push({
        name: 'USGS Historical Topos',
        url,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ── USGS Groundwater Data ──────────────────────────────────────

  private async queryGroundwater(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<GroundwaterResult | null> {
    const delta = 0.05;
    const bbox = `${(lng - delta).toFixed(4)},${(lat - delta).toFixed(4)},${(lng + delta).toFixed(4)},${(lat + delta).toFixed(4)}`;
    const url = `https://waterservices.usgs.gov/nwis/gwlevels/?format=json&bBox=${bbox}&siteType=GW&siteStatus=all&parameterCd=72019`;

    try {
      const data = await fetchWithRetry<any>(url, { retries: 2, timeout: 20000 });
      const sites: GroundwaterResult['sites'] = [];

      if (data?.value?.timeSeries) {
        for (const ts of data.value.timeSeries.slice(0, 20)) {
          const info = ts.sourceInfo || {};
          const values = ts.values?.[0]?.value || [];
          const latest = values[values.length - 1];

          sites.push({
            siteName: info.siteName || 'Unknown Well',
            siteNumber: info.siteCode?.[0]?.value || '',
            wellDepth: info.siteProperty?.find((p: any) => p.name === 'wellDepthVa')?.value || 'N/A',
            waterLevel: latest?.value ? `${latest.value} ft` : 'N/A',
          });
        }
      }

      dataSources.push({
        name: 'USGS Groundwater',
        url,
        status: sites.length > 0 ? 'success' : 'partial',
        error: sites.length === 0 ? 'No groundwater monitoring wells found nearby' : undefined,
      });

      return sites.length > 0 ? { siteCount: sites.length, sites } : null;
    } catch (err) {
      dataSources.push({
        name: 'USGS Groundwater',
        url,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ── Google Maps: Location Map ────────────────────────────────────

  private async fetchLocationMap(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<string | null> {
    const googleKeyEnv = this.config.research?.google_maps_api_key_env ?? 'GOOGLE_MAPS_API_KEY';
    const googleKey = process.env[googleKeyEnv];
    if (!googleKey) return null;

    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=14&size=640x640&maptype=roadmap&markers=color:red%7C${lat},${lng}&key=${googleKey}`;

    try {
      const buffer = await fetchBuffer(url);
      if (buffer) {
        dataSources.push({ name: 'Google Maps (Location Map)', url: url.replace(googleKey, '***'), status: 'success' });
        return buffer.toString('base64');
      }
      dataSources.push({ name: 'Google Maps (Location Map)', url: url.replace(googleKey, '***'), status: 'failed', error: 'No image data' });
      return null;
    } catch (err) {
      dataSources.push({ name: 'Google Maps (Location Map)', url: url.replace(googleKey, '***'), status: 'failed', error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ── Google Maps: Vicinity Map ──────────────────────────────────

  private async fetchVicinityMap(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<string | null> {
    const googleKeyEnv = this.config.research?.google_maps_api_key_env ?? 'GOOGLE_MAPS_API_KEY';
    const googleKey = process.env[googleKeyEnv];
    if (!googleKey) return null;

    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=640x640&maptype=hybrid&markers=color:red%7C${lat},${lng}&key=${googleKey}`;

    try {
      const buffer = await fetchBuffer(url);
      if (buffer) {
        dataSources.push({ name: 'Google Maps (Vicinity)', url: url.replace(googleKey, '***'), status: 'success' });
        return buffer.toString('base64');
      }
      dataSources.push({ name: 'Google Maps (Vicinity)', url: url.replace(googleKey, '***'), status: 'failed', error: 'No image data' });
      return null;
    } catch (err) {
      dataSources.push({ name: 'Google Maps (Vicinity)', url: url.replace(googleKey, '***'), status: 'failed', error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ── Google Street View (4 directions) ──────────────────────────

  private async fetchStreetViewImages(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<StreetViewImage[]> {
    const googleKeyEnv = this.config.research?.google_maps_api_key_env ?? 'GOOGLE_MAPS_API_KEY';
    const googleKey = process.env[googleKeyEnv];
    if (!googleKey) return [];

    const directions: { heading: number; direction: string }[] = [
      { heading: 0, direction: 'North' },
      { heading: 90, direction: 'East' },
      { heading: 180, direction: 'South' },
      { heading: 270, direction: 'West' },
    ];

    const images: StreetViewImage[] = [];
    let successCount = 0;

    for (const dir of directions) {
      const url = `https://maps.googleapis.com/maps/api/streetview?size=640x480&location=${lat},${lng}&heading=${dir.heading}&pitch=0&key=${googleKey}`;
      try {
        const buffer = await fetchBuffer(url);
        if (buffer && buffer.length > 5000) { // Street View returns a small "no image" placeholder if unavailable
          images.push({ heading: dir.heading, direction: dir.direction, base64: buffer.toString('base64') });
          successCount++;
        }
      } catch {}
    }

    dataSources.push({
      name: 'Google Street View',
      url: `https://maps.googleapis.com/maps/api/streetview?location=${lat},${lng}`,
      status: successCount > 0 ? 'success' : 'failed',
      error: successCount === 0 ? 'No Street View imagery available for this location' : undefined,
    });

    return images;
  }

  // ── EPA EJScreen ───────────────────────────────────────────────

  private async queryEJScreen(lat: number, lng: number, dataSources: DataSourceResult[]): Promise<EJScreenResult | null> {
    const geometry = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
    const url = `https://ejscreen.epa.gov/mapper/ejscreenRESTbroker.aspx?namestr=&geometry=${geometry}&distance=1&unit=9035&f=json`;

    try {
      const data = await fetchWithRetry<any>(url, { retries: 1, timeout: 20000 });

      if (data?.data) {
        const d = data.data;
        const result: EJScreenResult = {
          totalPopulation: d.totalPop || d.TOTALPOP || 'N/A',
          percentMinority: d.pctMinority || d.MINORPCT || 'N/A',
          percentLowIncome: d.pctLowIncome || d.LOWINCPCT || 'N/A',
          superfundProximity: d.pNPL || d.P_PNPL || 'N/A',
          rmpProximity: d.pRMP || d.P_PRMP || 'N/A',
          hazWasteProximity: d.pTSDFs || d.P_PTSDF || 'N/A',
          waterDischargeProximity: d.pWaterDis || d.P_PWDIS || 'N/A',
          airToxicsCancer: d.pCancerRisk || d.P_CANCER || 'N/A',
          dieselPM: d.pDiesel || d.P_DIESEL || 'N/A',
          leadPaint: d.pLeadPaint || d.P_LDPNT || 'N/A',
          rawData: d,
        };

        dataSources.push({ name: 'EPA EJScreen', url, status: 'success' });
        return result;
      }

      dataSources.push({ name: 'EPA EJScreen', url, status: 'partial', error: 'No EJScreen data returned' });
      return null;
    } catch (err) {
      dataSources.push({ name: 'EPA EJScreen', url, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  // ── Satellite Image ───────────────────────────────────────────────

  private async fetchSatelliteImage(
    lat: number,
    lng: number,
    dataSources: DataSourceResult[]
  ): Promise<string | null> {
    const enableSatellite = this.config.research?.enable_satellite_imagery !== false;
    const googleKeyEnv = this.config.research?.google_maps_api_key_env ?? 'GOOGLE_MAPS_API_KEY';
    const googleKey = process.env[googleKeyEnv];

    if (!enableSatellite || !googleKey) {
      return null;
    }

    const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=18&size=640x640&maptype=satellite&key=${googleKey}`;

    try {
      const buffer = await fetchBuffer(url);

      if (buffer) {
        dataSources.push({
          name: 'Google Static Maps (Satellite)',
          url: url.replace(googleKey, '***'),
          status: 'success',
        });
        return buffer.toString('base64');
      }

      dataSources.push({
        name: 'Google Static Maps (Satellite)',
        url: url.replace(googleKey, '***'),
        status: 'failed',
        error: 'No image data returned',
      });
      return null;
    } catch (err) {
      dataSources.push({
        name: 'Google Static Maps (Satellite)',
        url: url.replace(googleKey, '***'),
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
