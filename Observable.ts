module Util {

    export interface IObservable<T> {
        readonly promise: Promise<T>;
        observe(lambda: (obj: T) => void): ISubscription;
        map<U>(lambda: (obj: T) => U): IObservable<U>;
        mapPromise<U>(lambda: (obj: T) => Promise<U>, tempLambda?: (obj: T) => U): IObservable<U>;
        
    }

    export interface ISubscription {
        dispose(): void;
    }


    interface IUnsubscribable {
        unsubscribe(subscription: ISubscription): void;
    }

    abstract class CommonObservable<T> implements IObservable<T> {

        public get promise(){return this.getPromise();}
        abstract observe(func: (obj: T) => void);
        protected abstract getPromise(): Promise<T>;
        map<U>(lambda: (obj: T) => U): IObservable<U> {
            return new MapperObservable<T, U>(lambda, this);
        }
        mapPromise<U>(lambda: (obj: T) => Promise<U>, tempLambda?: (obj: T) => U): IObservable<U> {
            return new PromiseMapperObservable(lambda, this, tempLambda);
        }
    }

    export class Observable<T> implements IObservable<T>, IUnsubscribable {

        public static combine<U>(obj: {[K in keyof U]: IObservable<U[K]> }): IObservable<U> {
            return new CombinerObservable(obj);
        }

        private _value: T;
        private readonly subscriptions: Subscription<T>[] = [];

        constructor(value: T) {
            this._value = value;
        }


        //#region IObservable
        public get promise() {
            return Promise.resolve(this.value);
        }

        observe(valueUpdatedFunc: ((val: T) => void)): ISubscription {
            let sub = new Subscription(valueUpdatedFunc, this);
            this.subscriptions.push(sub);
            sub.valueUpdatedFunc(this.value);
            return sub;
        }

        map<U>(lambda: (obj: T) => U): IObservable<U> {
            return new MapperObservable<T, U>(lambda, this);
        }
        mapPromise<U>(lambda: (obj: T) => Promise<U>, tempLambda?: (obj: T) => U): IObservable<U> {
            return new PromiseMapperObservable<T, U>(lambda, this, tempLambda);
        }

        //#endregion IObservable

        public get value() {return this._value}
        public set value(val: T) {
            this._value = val;
            this.triggerUpdate();
        }

        public triggerUpdate() {
            for (let sub of this.subscriptions) {
                sub.valueUpdatedFunc(this.value);
            }
        }

        public unsubscribe(basicSubscription: Subscription<T>) {
            let idx = this.subscriptions.indexOf(basicSubscription);
            if (idx >= 0) {
                this.subscriptions.splice(idx, 1);
            }
            else {
                console.debug("Error: double unsubscribe", this);
            }
        }
    }

    export class PromiseObservable<T> extends CommonObservable<T> implements IObservable<T>, IUnsubscribable {


        private count = 0;
        private currentPromise: Promise<T>;
        private currentValue: { val: T } | null = null;
        private readonly subscriptions: Subscription<T>[] = [];


        constructor(initialValue: T) {
            super();
        }

        public setPromise(p: Promise<T>) {
            this.count++;
            this.currentPromise = p;
            this.currentValue = null;
            let currentCount = this.count;
            p.then(val => this.promiseDone(val, currentCount));
        }

        private promiseDone(val: T, startCount: number) {
            if (startCount === this.count) {
                this.currentValue = { val: val };
                for (let sub of this.subscriptions) {
                    sub.valueUpdatedFunc(val);
                }
            }
        }

        protected getPromise(): Promise<T> {
            return this.currentPromise;
        }

        observe(lambda: (obj: T) => void): ISubscription {
            let sub = new Subscription<T>(lambda, this);
            this.subscriptions.push(sub);
            if (this.currentValue) {
                sub.valueUpdatedFunc(this.currentValue.val);
            }
            return sub;
        }
        
        unsubscribe(subscription: ISubscription): void {
            let idx = this.subscriptions.indexOf(subscription as Subscription<T>);
            if (idx >= 0) {
                this.subscriptions.splice(idx, 1);
            }
            else {
                console.debug("Error: double unsubscribe", this);
            }
        }
    }


    class Subscription<T> implements ISubscription {

        constructor(
            public readonly valueUpdatedFunc: ((val: T) => void),
            private readonly parent: IUnsubscribable
        ) {

        }

        public dispose() {
            this.parent.unsubscribe(this);
        }
    }

    class MapperObservable<TSource, TTarget> implements IObservable<TTarget>, IUnsubscribable {

        private parentSubscription: ISubscription | null = null;
        private readonly subscriptions: Subscription<TTarget>[] = [];
        private currentValue: {val:TTarget} | null = null;

        constructor(
            private readonly mapperFunc: ((srcVal: TSource) => TTarget),
            private readonly sourceObservable: IObservable<TSource>
        ) {
        }

        public get promise(): Promise<TTarget> {
            return this.sourceObservable.promise.then(v => this.mapperFunc(v));
        }

        public observe(valueUpdatedFunc: ((val: TTarget) => void)): ISubscription {
            let sub = new Subscription(valueUpdatedFunc, this);
            this.subscriptions.push(sub);
            if (!this.parentSubscription) {
                this.parentSubscription = this.sourceObservable.observe(sourceVal => this.parentTriggered(sourceVal));
            }
            if (this.currentValue) {
                sub.valueUpdatedFunc(this.currentValue.val);
            }
            return sub;
        }

        public map<U>(lambda: (obj: TTarget) => U): IObservable<U> {
            return new MapperObservable<TTarget, U>(lambda, this);
        }
        mapPromise<U>(lambda: (obj: TTarget) => Promise<U>, tempLambda?: (obj: TTarget) => U): IObservable<U> {
            return new PromiseMapperObservable<TTarget, U>(lambda, this, tempLambda);
        }

        private parentTriggered(val: TSource) {
            if (this.subscriptions.length > 0) {
                let mappedVal = this.mapperFunc(val);
                this.currentValue = {val:mappedVal};
                for (let sub of this.subscriptions) {
                    sub.valueUpdatedFunc(mappedVal);
                }
            }
        }

        public unsubscribe(sub: Subscription<TTarget>) {
            let idx = this.subscriptions.indexOf(sub);
            if (idx >= 0) {
                this.subscriptions.splice(idx, 1);
            }
            if (this.subscriptions.length <= 0 && this.parentSubscription) {
                this.parentSubscription.dispose();
                this.parentSubscription = null;
            }
        }
    }

    class PromiseMapperObservable<TSource, TTarget> implements IObservable<TTarget>, IUnsubscribable {
        
        private count = 0;
        private lastpromise: Promise<TTarget> | undefined = undefined;
        private currentValue: {val:TTarget} | undefined = undefined;
        private parentSubscription: ISubscription | undefined = undefined;;
        private readonly subscriptions: Subscription<TTarget>[] = [];

        constructor(
            private readonly mapperFunc: ((sourceVal: TSource) => Promise<TTarget>),
            private readonly sourceObservable: IObservable<TSource>,
            private readonly temporaryMapperFunc?: ((sourceVal:TSource) => TTarget),
        ) {
        }

        public get promise(): Promise<TTarget> {
            if (!this.lastpromise) {
                this.lastpromise = this.sourceObservable.promise.then(sourceVal => this.mapperFunc(sourceVal));
            }
            return this.lastpromise;
        }

        observe(lambda: (obj: TTarget) => void): ISubscription {
            let sub = new Subscription(lambda, this);
            this.subscriptions.push(sub);
            if (!this.parentSubscription) {
                
                this.parentSubscription = this.sourceObservable.observe(sourceVal => this.parentTriggered(sourceVal));
            }
            if (this.currentValue){
                sub.valueUpdatedFunc(this.currentValue.val);
            }
            return sub;
        }
        map<U>(lambda: (obj: TTarget) => U): IObservable<U> {
            return new MapperObservable(lambda, this);
        }
        mapPromise<U>(lambda: (obj: TTarget) => Promise<U>, tempLambda?: (obj: TTarget) => U): IObservable<U> {
            return new PromiseMapperObservable<TTarget, U>(lambda, this, tempLambda);
        }

        public unsubscribe(subscription: Subscription<TTarget>): void {
            let idx = this.subscriptions.indexOf(subscription);
            if (idx >= 0) {
                this.subscriptions.splice(idx, 1);
            }
            if (this.subscriptions.length <= 0 && this.parentSubscription) {
                this.parentSubscription.dispose();
                this.parentSubscription = undefined;
            }
        }

        private async parentTriggered(sourceVal: TSource) {
            if (this.temporaryMapperFunc){
                let tempMappedVal = this.temporaryMapperFunc(sourceVal);
                this.currentValue = {val:tempMappedVal};
                for (let sub of this.subscriptions){
                    sub.valueUpdatedFunc(tempMappedVal);
                }
            }
            this.count++;
            let startCount = this.count; 
            let mappedval = await this.mapperFunc(sourceVal);
            if (startCount === this.count){

                this.currentValue = {val:mappedval};
                
                for (let sub of this.subscriptions) {
                    sub.valueUpdatedFunc(mappedval);
                }
            }
        }
    }

    
    class CombinerObservable<T> implements IObservable<T>, IUnsubscribable {

        private parentSubscriptions: { [k in keyof T]: ISubscription } | null = null;
        private value: Partial<T> = {};
        private readonly parentesInitialized: {[k in keyof T]: boolean };
        private readonly subscriptions: Subscription<T>[] = [];

        constructor(private readonly parents: {[K in keyof T]: IObservable<T[K]> }) {
            this.parentesInitialized = ({} as any);
            for (let parentName in parents) {
                this.parentesInitialized[parentName] = false;
            }
        }

        public unsubscribe(subscription: Subscription<T>): void {
            let idx = this.subscriptions.indexOf(subscription);
            if (idx >= 0) {
                this.subscriptions.splice(idx, 1);
            }
            if (this.subscriptions.length <= 0 && this.parentSubscriptions) {
                for (let parentName in this.parentSubscriptions) {
                    this.parentSubscriptions[parentName].dispose();
                }
                this.parentSubscriptions = null;
            }
        }
        public get promise(): Promise<T> {
            let result: Partial<T> = {};
            let promises: Promise<any>[] = [];
            for (let parentName in this.parents) {
                promises.push(this.parents[parentName].promise.then(v => result[parentName] = v))
            }
            return Promise.all(promises).then(uselessList => result as T);
        }

        observe(lambda: (obj: T) => void): ISubscription {
            let sub = new Subscription<T>(lambda, this);
            this.subscriptions.push(sub);
            if (!this.parentSubscriptions) {
                this.parentSubscriptions = {} as {[k in keyof T]: ISubscription };
                for (let parentName in this.parents) {
                    this.parentSubscriptions[parentName] = this.parents[parentName]
                        .observe(parentValue => this.parentTriggered(parentValue, parentName));
                }
            }

            if (this.allParentsInitialized){
                sub.valueUpdatedFunc(this.value as T);
            }
            return sub;
        }
        map<U>(lambda: (obj: T) => U): IObservable<U> {
            return new MapperObservable(lambda, this);
        }
        mapPromise<U>(lambda: (obj: T) => Promise<U>, tempLambda?: (obj: T) => U): IObservable<U> {
            return new PromiseMapperObservable<T, U>(lambda, this, tempLambda);
        }

        private parentTriggered<K extends keyof T>(parentValue: T[K], parentName: K) {
            this.parentesInitialized[parentName] = true;
            this.value[parentName] = parentValue;

            if (this.allParentsInitialized){

                let completeValue = this.value as T;
                
                //trigger subscriptions
                for (let sub of this.subscriptions) {
                    sub.valueUpdatedFunc(completeValue);
                }
            }
        }

        private get allParentsInitialized(): boolean{
            for (let parentName in this.parents){
                if (!this.parentesInitialized[parentName]){
                    return false;
                }
            }
            return true;
        }
    }

    
}
