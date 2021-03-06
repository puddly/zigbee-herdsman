/* istanbul ignore file */
/* eslint-disable */
import {
    NetworkOptions, SerialPortOptions, Coordinator, CoordinatorVersion, NodeDescriptor,
    DeviceType, ActiveEndpoints, SimpleDescriptor, LQI, RoutingTable, Backup as BackupType, NetworkParameters,
    StartResult, LQINeighbor, RoutingTableEntry
} from '../../tstype';
import Debug from "debug";
import Adapter from '../../adapter';
const debug = Debug("zigbee-herdsman:deconz:adapter");
import Driver from '../driver/driver';
import {ZclFrame, FrameType, Direction, Foundation} from '../../../zcl';
import * as Events from '../../events';
import * as Zcl from '../../../zcl';
import processFrame from '../driver/frameParser';
import {Queue} from '../../../utils';
import PARAM from '../driver/constants';
import { Command, WaitForDataRequest, ApsDataRequest, ReceivedDataResponse, DataStateResponse } from '../driver/constants';

var frameParser = require('../driver/frameParser');
class DeconzAdapter extends Adapter {
    private driver: Driver;
    private queue: Queue;
    private openRequestsQueue: WaitForDataRequest[];
    private transactionID: number;
    private frameParserEvent = frameParser.frameParserEvents;
    private joinPermitted: boolean;
    private fwVersion: CoordinatorVersion;

    public constructor(networkOptions: NetworkOptions, serialPortOptions: SerialPortOptions, backupPath: string) {
        super(networkOptions, serialPortOptions, backupPath);

        this.driver = new Driver(serialPortOptions.path);
        this.driver.on('rxFrame', (frame) => {processFrame(frame)});
        this.queue = new Queue(2);
        this.transactionID = 0;
        this.openRequestsQueue = [];
        this.joinPermitted = false;
        this.fwVersion = null;
        console.log('CREATED DECONZ ADAPTER');

        this.frameParserEvent.on('receivedDataPayload', (data: any) => {this.checkReceivedDataPayload(data)});

        const that = this;
        setInterval(() => { that.checkReceivedDataPayload(null); }, 1000);
    }

    public static async isValidPath(path: string): Promise<boolean> {
        return Driver.isValidPath(path);
    }

    public static async autoDetectPath(): Promise<string> {
        return Driver.autoDetectPath();
    }

    /**
     * Adapter methods
     */
    public async start(): Promise<StartResult> {
        await this.driver.open();
        return "resumed";
    }

    public async stop(): Promise<void> {
        this.driver.close();
    }

    public async getCoordinator(): Promise<Coordinator> {
            const ieeeAddr: any = await this.driver.readParameterRequest(PARAM.PARAM.Network.MAC);
            const nwkAddr: any = await this.driver.readParameterRequest(PARAM.PARAM.Network.NWK_ADDRESS);

            const endpoints: any = [{
                    ID: 0x01,
                    profileID: 0x0104,
                    deviceID: 0x0005,
                    inputClusters: [0x0019, 0x000A],
                    outputClusters: [0x0500]
                },
                {
                    ID: 0xF2,
                    profileID: 0xA1E0,
                    deviceID: 0x0064,
                    inputClusters: [],
                    outputClusters: [0x0021]
                }];

            return {
                networkAddress: nwkAddr,
                manufacturerID: 0x1135,
                ieeeAddr: ieeeAddr,
                endpoints,
            };
    }

    public async permitJoin(seconds: number, networkAddress: number): Promise<void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, seconds, 0]; // tc_significance 1 or 0 ?

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress || 0xFFFC;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x36; // permit join
        request.srcEndpoint = 0;
        request.asduLength = 3;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 5;

        try {
            await this.driver.enqueueSendDataRequest(request);
            if (seconds === 0) {
                this.joinPermitted = false;
            } else {
                this.joinPermitted = true;
            }
            this.driver.writeParameterRequest(PARAM.PARAM.Network.PERMIT_JOIN, seconds);

            debug("PERMIT_JOIN - " + seconds + " seconds");
        } catch (error) {
            debug("PERMIT_JOIN FAILED - " + error);
            return Promise.reject();
        }
    }

    public async getCoordinatorVersion(): Promise<CoordinatorVersion> {
        // product: number; transportrev: number; majorrel: number; minorrel: number; maintrel: number; revision: string;
        if (this.fwVersion != null) {
            return this.fwVersion;
        } else {
            try {
                const fw = await this.driver.readFirmwareVersionRequest();
                const buf = Buffer.from(fw);
                let fwString = "0x" + buf.readUInt32LE(0).toString(16);
                const type: string = (fw[1] === 5) ? "RaspBee" : "ConBee2";
                const meta = {"transportrev":0, "product":0, "majorrel": fw[3], "minorrel": fw[2], "maintrel":0, "revision":fwString};
                this.fwVersion = {type: type, meta: meta};
                return {type: type, meta: meta};
            } catch (error) {
                debug("Get coordinator version Error: " + error);
            }
        }
    }

    public async reset(type: 'soft' | 'hard'): Promise<void> {
        return Promise.reject();
    }

    public async setLED(enabled: boolean): Promise<void> {
        return Promise.reject();
    }

    public async lqi(networkAddress: number): Promise<LQI> {
            const neighbors: LQINeighbor[] = [];

            const add = (list: any) => {
                for (const entry of list) {
                    const relationByte = entry.readUInt8(18);
                    const extAddr: number[] = [];
                    for (let i = 8; i < 16; i++) {
                        extAddr.push(entry[i]);
                    }

                    neighbors.push({
                        linkquality: entry.readUInt8(21),
                        networkAddress: entry.readUInt16LE(16),
                        ieeeAddr: this.driver.macAddrArrayToString(extAddr),
                        relationship: (relationByte >> 1) & ((1 << 3)-1),
                        depth: entry.readUInt8(20)
                    });
                }
            };

            const request = async (startIndex: number): Promise<any> => {
                const transactionID = this.nextTransactionID();
                const req: ApsDataRequest = {};
                req.requestId = transactionID;
                req.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
                req.destAddr16 = networkAddress;
                req.destEndpoint = 0;
                req.profileId = 0;
                req.clusterId = 0x31; // mgmt_lqi_request
                req.srcEndpoint = 0;
                req.asduLength = 2;
                req.asduPayload = [transactionID, startIndex];
                req.txOptions = 0;
                req.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;

                this.driver.enqueueSendDataRequest(req)
                .then(result => {})
                .catch(error => {});

                try {
                    const d = await this.waitForData(networkAddress, 0, 0x8031);
                    const data = d.asduPayload;

                    if (data[1] !== 0) { // status
                        throw new Error(`LQI for '${networkAddress}' failed`);
                    }
                    const tableList: Buffer[] = [];
                    const response = {
                        status: data[1],
                        tableEntrys: data[2],
                        startIndex: data[3],
                        tableListCount: data[4],
                        tableList: tableList
                    }

                    let tableEntry: number[] = [];
                    let counter = 0;
                    for (let i = 5; i < ((response.tableListCount * 22) + 5); i++) { // one tableentry = 22 bytes
                        tableEntry.push(data[i]);
                        counter++;
                        if (counter === 22) {
                            response.tableList.push(Buffer.from(tableEntry));
                            tableEntry = [];
                            counter = 0;
                        }
                    }

                    debug("LQI RESPONSE - addr: 0x" + networkAddress.toString(16) + " status: " + response.status + " read " + (response.tableListCount + response.startIndex) + "/" + response.tableEntrys + " entrys");
                    return response;
                } catch (error) {
                    debug("LQI REQUEST FAILED - addr: 0x" + networkAddress.toString(16) + " " + error);
                    return Promise.reject();
                }
            };

            let response = await request(0);
            add(response.tableList);
            let nextStartIndex = response.tableListCount;

            while (neighbors.length < response.tableEntrys) {
                response = await request(nextStartIndex);
                add(response.tableList);
                nextStartIndex += response.tableListCount;
            }

            return {neighbors};
    }

    public async routingTable(networkAddress: number): Promise<RoutingTable> {
            const table: RoutingTableEntry[] = [];
            const statusLookup: {[n: number]: string} = {
                0: 'ACTIVE',
                1: 'DISCOVERY_UNDERWAY',
                2: 'DISCOVERY_FAILED',
                3: 'INACTIVE',
            };
            const add = (list: any) => {
                for (const entry of list) {
                    const statusByte = entry.readUInt8(2);
                    const extAddr: number[] = [];
                    for (let i = 8; i < 16; i++) {
                        extAddr.push(entry[i]);
                    }

                    table.push({
                        destinationAddress: entry.readUInt16LE(0),
                        status: statusLookup[(statusByte >> 5) & ((1 << 3)-1)],
                        nextHop: entry.readUInt16LE(3)
                    });
                }
            };

            const request = async (startIndex: number): Promise<any> => {
                const transactionID = this.nextTransactionID();
                const req: ApsDataRequest = {};
                req.requestId = transactionID;
                req.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
                req.destAddr16 = networkAddress;
                req.destEndpoint = 0;
                req.profileId = 0;
                req.clusterId = 0x32; // mgmt_rtg_request
                req.srcEndpoint = 0;
                req.asduLength = 2;
                req.asduPayload = [transactionID, startIndex];
                req.txOptions = 0;
                req.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
                req.timeout = 30;

                this.driver.enqueueSendDataRequest(req)
                .then(result => {})
                .catch(error => {});

                try {
                    const d = await this.waitForData(networkAddress, 0, 0x8032);
                    const data = d.asduPayload;

                    if (data[1] !== 0) { // status
                        throw new Error(`Routingtables for '${networkAddress}' failed`);
                    }
                    const tableList: Buffer[] = [];
                    const response = {
                        status: data[1],
                        tableEntrys: data[2],
                        startIndex: data[3],
                        tableListCount: data[4],
                        tableList: tableList
                    }

                    let tableEntry: number[] = [];
                    let counter = 0;
                    for (let i = 5; i < ((response.tableListCount * 5) + 5); i++) { // one tableentry = 5 bytes
                        tableEntry.push(data[i]);
                        counter++;
                        if (counter === 5) {
                            response.tableList.push(Buffer.from(tableEntry));
                            tableEntry = [];
                            counter = 0;
                        }
                    }

                    debug("ROUTING_TABLE RESPONSE - addr: 0x" + networkAddress.toString(16) + " status: " + response.status + " read " + (response.tableListCount + response.startIndex) + "/" + response.tableEntrys + " entrys");
                    return response;
                } catch (error) {
                    debug("ROUTING_TABLE REQUEST FAILED - addr: 0x" + networkAddress.toString(16) + " " + error);
                    return Promise.reject();
                }
            };

            let response = await request(0);
            add(response.tableList);
            let nextStartIndex = response.tableListCount;

            while (table.length < response.tableEntrys) {
                response = await request(nextStartIndex);
                add(response.tableList);
                nextStartIndex += response.tableListCount;
            }

            return {table};
    }

    public async nodeDescriptor(networkAddress: number): Promise<NodeDescriptor> {
        const transactionID = this.nextTransactionID();
        const nwk1 = networkAddress & 0xff;
        const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, nwk1, nwk2];

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x02; // node descriptor
        request.srcEndpoint = 0;
        request.asduLength = 3;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver.enqueueSendDataRequest(request)
            .then(result => {})
            .catch(error => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8002);
            const data = d.asduPayload;

            const buf = Buffer.from(data);
            const logicaltype = (data[4] & 7);
            const type: DeviceType = (logicaltype === 1) ? 'Router' : (logicaltype === 2) ? 'EndDevice' : (logicaltype === 0) ? 'Coordinator' : 'Unknown';
            const manufacturer = buf.readUInt16LE(7);

            debug("RECEIVING NODE_DESCRIPTOR - addr: 0x" + networkAddress.toString(16) + " type: " + type + " manufacturer: 0x" + manufacturer.toString(16));
            return {manufacturerCode: manufacturer, type};
        } catch (error) {
            debug("RECEIVING NODE_DESCRIPTOR FAILED - addr: 0x" + networkAddress.toString(16) + " " + error);
            return Promise.reject();
        }
    }

    public async activeEndpoints(networkAddress: number): Promise<ActiveEndpoints> {
        const transactionID = this.nextTransactionID();
        const nwk1 = networkAddress & 0xff;
        const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, nwk1, nwk2];

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x05; // active endpoints
        request.srcEndpoint = 0;
        request.asduLength = 3;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver.enqueueSendDataRequest(request)
            .then(result => {})
            .catch(error => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8005);
            const data = d.asduPayload;

            const buf = Buffer.from(data);
            const epCount = buf.readUInt8(4);
            const epList = [];
            for (let i = 5; i < (epCount + 5); i++) {
                epList.push(buf.readUInt8(i));
            }
            debug("ACTIVE_ENDPOINTS - addr: 0x" + networkAddress.toString(16) + " EP list: " + epList);
            return {endpoints: epList};
        } catch (error) {
            debug("READING ACTIVE_ENDPOINTS FAILED - addr: 0x" + networkAddress.toString(16) + " " + error);
            return Promise.reject();
        }
    }

    public async simpleDescriptor(networkAddress: number, endpointID: number): Promise<SimpleDescriptor> {
        const transactionID = this.nextTransactionID();
        const nwk1 = networkAddress & 0xff;
        const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID, nwk1, nwk2, endpointID];

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x04; // simple descriptor
        request.srcEndpoint = 0;
        request.asduLength = 4;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver.enqueueSendDataRequest(request)
            .then(result => {})
            .catch(error => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8004);
            const data = d.asduPayload;

            const buf = Buffer.from(data);
            const inCount = buf.readUInt8(11);
            const inClusters = [];
            let cIndex = 12;
            for (let i = 0; i < inCount; i++) {
                inClusters[i] = buf.readUInt16LE(cIndex);
                cIndex += 2;
            }
            const outCount = buf.readUInt8(12 + (inCount*2));
            const outClusters = [];
            cIndex = 13 + (inCount*2);
            for (let l = 0; l < outCount; l++) {
                outClusters[l] = buf.readUInt16LE(cIndex);
                cIndex += 2;
            }

            const simpleDesc = {
                profileID: buf.readUInt16LE(6),
                endpointID: buf.readUInt8(5),
                deviceID: buf.readUInt16LE(8),
                inputClusters: inClusters,
                outputClusters: outClusters
            }
            debug("RECEIVING SIMPLE_DESCRIPTOR - addr: 0x" + networkAddress.toString(16) + " EP:" + endpointID + " inClusters: " + inClusters + " outClusters: " + outClusters);
            return simpleDesc;
        } catch (error) {
            debug("RECEIVING SIMPLE_DESCRIPTOR FAILED - addr: 0x" + networkAddress.toString(16) + " EP:" + endpointID + " " + error);
            return Promise.reject();
        }
    }

    public waitFor(
        networkAddress: number, endpoint: number, frameType: FrameType, direction: Direction,
        transactionSequenceNumber: number, clusterID: number, commandIdentifier: number, timeout: number,
    ): {promise: Promise<Events.ZclDataPayload>; cancel: () => void} {
        return null;
    }

    public async sendZclFrameToEndpoint(
        networkAddress: number, endpoint: number, zclFrame: ZclFrame, timeout: number
    ): Promise<Events.ZclDataPayload> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        let frameControl: string = "";
        frameControl += (0);
        frameControl += (0);
        frameControl += (0);
        frameControl += ((zclFrame.Header.frameControl.disableDefaultResponse) ? 1 : 0);
        frameControl += (zclFrame.Header.frameControl.direction);
        frameControl += ((zclFrame.Header.frameControl.manufacturerSpecific) ? 1 : 0);
        frameControl += (0);
        frameControl += (zclFrame.Header.frameControl.frameType);
        const payload = [parseInt(frameControl,2), zclFrame.Header.transactionSequenceNumber, zclFrame.Header.commandIdentifier];

        for (let i in zclFrame.Payload) {
            let entry = zclFrame.Payload[i];
            if ((typeof entry) === 'object') {
                const array: number[] = Object.values(entry);
                for (let val in array) {
                    payload.push(array[val] & 0xff);
                    payload.push((array[val] >> 8) & 0xff);
                }
            } else {
                payload.push(entry);
            }
        }

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = endpoint;
        request.profileId = 0x104;
        request.clusterId = zclFrame.Cluster.ID;
        request.srcEndpoint = 1;
        request.asduLength = payload.length;
        request.asduPayload = payload;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = timeout;

        this.driver.enqueueSendDataRequest(request)
            .then(result => {
                debug(`sendZclFrameToEndpoint - message send`);
            })
            .catch(error => {
                debug(`sendZclFrameToEndpoint ERROR: ${error}`);
                return Promise.reject();
            });

            try {
                const data = await this.waitForData(networkAddress, 0x104, zclFrame.Cluster.ID);
                const asdu = data.asduPayload;
                const buffer = Buffer.from(asdu);
                const frame: ZclFrame = ZclFrame.fromBuffer(zclFrame.Cluster.ID, buffer);
                const response: Events.ZclDataPayload = {
                    address: (data.srcAddrMode === 0x02) ? data.srcAddr16 : null,
                    frame: frame,
                    endpoint: data.srcEndpoint,
                    linkquality: data.lqi,
                    groupID: (data.srcAddrMode === 0x01) ? data.srcAddr16 : null
                };
                debug(`response received`);
                return response;
            } catch (error) {
                //debug(`no response received`);
                return null;
            }
    }

    public async sendZclFrameToGroup(groupID: number, zclFrame: ZclFrame): Promise<void> {
        const transactionID = this.nextTransactionID();
        const request: ApsDataRequest = {};
        let frameControl: string = "";
        frameControl += (0);
        frameControl += (0);
        frameControl += (0);
        frameControl += ((zclFrame.Header.frameControl.disableDefaultResponse) ? 1 : 0);
        frameControl += (zclFrame.Header.frameControl.direction);
        frameControl += ((zclFrame.Header.frameControl.manufacturerSpecific) ? 1 : 0);
        frameControl += (0);
        frameControl += (zclFrame.Header.frameControl.frameType);
        const payload = [parseInt(frameControl,2), zclFrame.Header.transactionSequenceNumber, zclFrame.Header.commandIdentifier];
        for (let i in zclFrame.Payload) {
            let entry = zclFrame.Payload[i];
            if ((typeof entry) === 'object') {
                const array: number[] = Object.values(entry);
                for (let val in array) {
                    payload.push(array[val] & 0xff);
                    payload.push((array[val] >> 8) & 0xff);
                }
            } else {
                payload.push(entry);
            }
        }

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.GROUP_ADDR;
        request.destAddr16 = groupID;
        request.profileId = 0x104;
        request.clusterId = zclFrame.Cluster.ID;
        request.srcEndpoint = 1;
        request.asduLength = payload.length;
        request.asduPayload = payload;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.UNLIMITED;

        try {
            return this.driver.enqueueSendDataRequest(request) as Promise<void>;
        } catch (error) {
            debug(`sendZclFrameToGroup ERROR: ${error}`);
            return Promise.reject();
        }
    }

    public async bind(
        destinationNetworkAddress: number, sourceIeeeAddress: string, sourceEndpoint: number,
        clusterID: number, destinationAddressOrGroup: string | number, type: 'endpoint' | 'group',
        destinationEndpoint?: number
    ): Promise<void> {
        const transactionID = this.nextTransactionID();
        const clid1 = clusterID & 0xff;
        const clid2 = (clusterID >> 8) & 0xff;
        const destAddrMode = (type === 'group') ? PARAM.PARAM.addressMode.GROUP_ADDR : PARAM.PARAM.addressMode.IEEE_ADDR;
        let destArray: number[];
        if (type === 'endpoint') {
            destArray = this.driver.macAddrStringToArray(destinationAddressOrGroup as string);
            destArray = destArray.concat([destinationEndpoint]);
        } else {
            destArray = [destinationAddressOrGroup as number & 0xff, ((destinationAddressOrGroup as number) >> 8) & 0xff];
        }

        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID].concat(this.driver.macAddrStringToArray(sourceIeeeAddress)).concat(
            [sourceEndpoint,clid1,clid2,destAddrMode]).concat(destArray);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = destinationNetworkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x21; // bind_request
        request.srcEndpoint = 0;
        request.asduLength = zdpFrame.length;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver.enqueueSendDataRequest(request)
            .then(result => {})
            .catch(error => {});

        try {
            const d = await this.waitForData(destinationNetworkAddress, 0, 0x8021);
            const data = d.asduPayload;
            debug("BIND RESPONSE - addr: 0x" + destinationNetworkAddress.toString(16) + " status: " + data[1]);
            if (data[1] !== 0) {
                return Promise.reject();
            }
        } catch (error) {
            debug("BIND FAILED - addr: 0x" + destinationNetworkAddress.toString(16) + " " + error);
            return Promise.reject();
        }
    }

    public async unbind(
        destinationNetworkAddress: number, sourceIeeeAddress: string, sourceEndpoint: number,
        clusterID: number, destinationAddressOrGroup: string | number, type: 'endpoint' | 'group',
        destinationEndpoint: number
    ): Promise<void> {
        const transactionID = this.nextTransactionID();
        const clid1 = clusterID & 0xff;
        const clid2 = (clusterID >> 8) & 0xff;
        const destAddrMode = (type === 'group') ? PARAM.PARAM.addressMode.GROUP_ADDR : PARAM.PARAM.addressMode.IEEE_ADDR;
        let destArray: number[];
        if (type === 'endpoint') {
            destArray = this.driver.macAddrStringToArray(destinationAddressOrGroup as string);
            destArray.concat([destinationEndpoint]);
        } else {
            destArray = [destinationAddressOrGroup as number & 0xff, ((destinationAddressOrGroup as number) >> 8) & 0xff];
        }
        const request: ApsDataRequest = {};
        const zdpFrame = [transactionID].concat(this.driver.macAddrStringToArray(sourceIeeeAddress)).concat(
            [sourceEndpoint,clid1,clid2,destAddrMode]).concat(destArray);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = destinationNetworkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x22; // unbind_request
        request.srcEndpoint = 0;
        request.asduLength = zdpFrame.length;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;
        request.timeout = 30;

        this.driver.enqueueSendDataRequest(request)
            .then(result => {})
            .catch(error => {});

        try {
            const d = await this.waitForData(destinationNetworkAddress, 0, 0x8022);
            const data = d.asduPayload;
            debug("UNBIND RESPONSE - addr: 0x" + destinationNetworkAddress.toString(16) + " status: " + data[1]);
            if (data[1] !== 0) {
                return Promise.reject();
            }
        } catch (error) {
            debug("UNBIND FAILED - addr: 0x" + destinationNetworkAddress.toString(16) + " " + error);
            return Promise.reject();
        }
    }

    public async removeDevice(networkAddress: number, ieeeAddr: string): Promise<void> {
        console.log("remove device ieee Addr");
        console.log(ieeeAddr);
        const transactionID = this.nextTransactionID();
        const nwk1 = networkAddress & 0xff;
        const nwk2 = (networkAddress >> 8) & 0xff;
        const request: ApsDataRequest = {};
        //const zdpFrame = [transactionID].concat(this.driver.macAddrStringToArray(ieeeAddr)).concat([0]);
        const zdpFrame = [transactionID].concat([0,0,0,0,0,0,0,0]).concat([0]);

        request.requestId = transactionID;
        request.destAddrMode = PARAM.PARAM.addressMode.NWK_ADDR;
        request.destAddr16 = networkAddress;
        request.destEndpoint = 0;
        request.profileId = 0;
        request.clusterId = 0x34; // mgmt_leave_request
        request.srcEndpoint = 0;
        request.asduLength = 10;
        request.asduPayload = zdpFrame;
        request.txOptions = 0;
        request.radius = PARAM.PARAM.txRadius.DEFAULT_RADIUS;

        this.driver.enqueueSendDataRequest(request)
            .then(result => {})
            .catch(error => {});

        try {
            const d = await this.waitForData(networkAddress, 0, 0x8034);
            const data = d.asduPayload;
            debug("REMOVE_DEVICE - addr: 0x" + networkAddress.toString(16) + " status: " + data[1]);
            const payload: Events.DeviceLeavePayload = {
                networkAddress: networkAddress,
                ieeeAddr: ieeeAddr,
            };
            if (data[1] !== 0) {
                return Promise.reject();
            }
            this.emit(Events.Events.deviceLeave, payload);
        } catch (error) {
            debug("REMOVE_DEVICE FAILED - addr: 0x" + networkAddress.toString(16) + " " + error);
            return Promise.reject();
        }
    }

    public async supportsBackup(): Promise<boolean> {
        return false;
    }

    public async backup(): Promise<BackupType> {
        return Promise.reject();
    }

    public async getNetworkParameters(): Promise<NetworkParameters> {
        try {
            const panid: any = await this.driver.readParameterRequest(PARAM.PARAM.Network.PAN_ID);
            const expanid: any = await this.driver.readParameterRequest(PARAM.PARAM.Network.EXT_PAN_ID);
            const channel: any = await this.driver.readParameterRequest(PARAM.PARAM.Network.CHANNEL);

            return {
                panID: panid,
                extendedPanID: expanid,
                channel: channel
            };
        } catch (error) {
            debug("get network parameters Error:" + error);
            return Promise.reject();
        }
    }

    public async supportsLED(): Promise<boolean> {
        return false;
    }

    public async restoreChannelInterPAN(): Promise<void> {
        return Promise.reject();
    }

    public async sendZclFrameInterPANToIeeeAddr(zclFrame: ZclFrame, ieeeAddr: string): Promise<void> {
        return Promise.reject();
    }

    public async sendZclFrameInterPANBroadcast(
        zclFrame: ZclFrame, timeout: number
    ): Promise<Events.ZclDataPayload> {
        return Promise.reject();
    }

    public async sendZclFrameInterPANBroadcastWithResponse(
        zclFrame: ZclFrame, timeout: number
    ): Promise<Events.ZclDataPayload> {
        return Promise.reject();
    }

    public async setChannelInterPAN(channel: number): Promise<void> {
        return Promise.reject();
    }

    public async setTransmitPower(value: number): Promise<void> {
        return Promise.reject();
    }

    public async sendZclFrameInterPANIeeeAddr(zclFrame: ZclFrame, ieeeAddr: any): Promise<void> {
        return Promise.reject();
    }

    /**
     * Private methods
     */
    private waitForData(addr: number, profileId: number, clusterId: number) : Promise<ReceivedDataResponse> {
        return new Promise((resolve, reject): void => {
            const ts = Date.now();
            const commandId = PARAM.PARAM.APS.DATA_INDICATION;
            const req: WaitForDataRequest = {addr, profileId, clusterId, resolve, reject, ts};
            this.openRequestsQueue.push(req);
        });
    }

    private checkReceivedDataPayload(resp: ReceivedDataResponse) {
        let srcAddr: any = null;
        if (resp != null) {
            srcAddr = (resp.srcAddr16 != null) ? resp.srcAddr16 : resp.srcAddr64;
        }

        let i = this.openRequestsQueue.length;
        while (i--) {
            const req: WaitForDataRequest = this.openRequestsQueue[i];
            if (srcAddr != null && req.addr === srcAddr && req.clusterId === resp.clusterId && req.profileId === resp.profileId) {
                this.openRequestsQueue.splice(i, 1);
                req.resolve(resp);
            }

            const now = Date.now();
            if ((now - req.ts) > 60000) { // 60 seconds
                //debug("Timeout for request in openRequestsQueue addr: " + req.addr.toString(16) + " clusterId: " + req.clusterId.toString(16) + " profileId: " + req.profileId.toString(16));
                //remove from busyQueue
                this.openRequestsQueue.splice(i, 1);
                req.reject("openRequest TIMEOUT");
            }
        }

        // check unattended incomming messages
        if (resp != null && resp.profileId === 0x00 && resp.clusterId === 0x13) {
            // device Annce
            const payBuf = Buffer.from(resp.asduPayload);
            const payload: Events.DeviceJoinedPayload = {
                networkAddress: payBuf.readUInt16LE(1),
                ieeeAddr: this.driver.macAddrArrayToString(resp.asduPayload.slice(3,11)),
            };
            if (this.joinPermitted === true) {
                this.emit(Events.Events.deviceJoined, payload);
            } else {
                this.emit(Events.Events.deviceAnnounce, payload);
            }
        }
        if (resp != null && resp.profileId != 0x00) {
            const payBuf = Buffer.from(resp.asduPayload);
            try {
                const payload: Events.ZclDataPayload = {
                    frame: ZclFrame.fromBuffer(resp.clusterId, payBuf),
                    address: (resp.destAddrMode === 0x03) ? resp.srcAddr64 : resp.srcAddr16,
                    endpoint: resp.srcEndpoint,
                    linkquality: resp.lqi,
                    groupID: (resp.destAddrMode === 0x01) ? resp.destAddr16 : null
                };

                this.emit(Events.Events.zclData, payload);
            } catch (error) {
                const payload: Events.RawDataPayload = {
                    clusterID: resp.clusterId,
                    data: payBuf,
                    address: (resp.destAddrMode === 0x03) ? resp.srcAddr64 : resp.srcAddr16,
                    endpoint: resp.srcEndpoint,
                    linkquality: resp.lqi,
                    groupID: (resp.destAddrMode === 0x01) ? resp.destAddr16 : null
                };

                this.emit(Events.Events.rawData, payload);
            }
        }
    }

    private nextTransactionID(): number {
        this.transactionID++;

        if (this.transactionID > 255) {
            this.transactionID = 1;
        }

        return this.transactionID;
    }
}


export default DeconzAdapter;
