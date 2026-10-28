import React from 'react';
import { BackHandler } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { HomeScreen } from './HomeScreen';

export const JobListScreen: React.FC = (props: any) => {
  useFocusEffect(
    React.useCallback(() => {
      const onBackPress = () => {
        // Exit or minimize app from the main roster instead of traversing back to completed screens
        BackHandler.exitApp();
        return true;
      };
      const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => subscription.remove();
    }, [])
  );

  return <HomeScreen {...props} />;
};

export { JobListScreen as JobsScreen };
